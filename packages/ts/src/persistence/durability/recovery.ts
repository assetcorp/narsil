import { applyDeleteEntry, applyIndexEntry } from '../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { readMetadataEnvelope } from '../../serialization/envelope'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'
import { type CommitMarkerState, readCommitMarker } from './commit-marker'
import type { DurableDirectory } from './durable-filesystem'
import { checkpointLastSeqNo, decodeSnapshotBundle, type PartitionCheckpoint } from './snapshot-bundle'
import { checkSegmentHeader, readDurableRegion, SEGMENT_HEADER_SIZE } from './wal-framing'

export interface RecoveredIndex {
  metadata: IndexMetadata
  highestSeqNoByPartition: Map<number, number>
  primaryTermByPartition: Map<number, number>
}

export interface ReplayDeps {
  manager: PartitionManager
  vectorFieldPaths: Set<string>
  vectorIndexes: Map<string, VectorIndex>
}

export async function listPersistedIndexes(directory: DurableDirectory): Promise<string[]> {
  const metaKeys = await directory.list('')
  const names: string[] = []
  for (const key of metaKeys) {
    if (key.endsWith('/meta')) {
      names.push(key.slice(0, -'/meta'.length))
    }
  }
  return names
}

export async function loadMetadata(directory: DurableDirectory, indexName: string): Promise<IndexMetadata | null> {
  const bytes = await directory.read(`${indexName}/meta`)
  if (bytes === null) {
    return null
  }
  const { metadata } = await readMetadataEnvelope(bytes)
  return metadata
}

export async function loadSnapshotBundleBytes(bytes: Uint8Array, deps: ReplayDeps): Promise<PartitionCheckpoint[]> {
  const bundle = await decodeSnapshotBundle(bytes)

  while (deps.manager.partitionCount < bundle.partitions.length) {
    deps.manager.addPartition()
  }
  for (let i = 0; i < bundle.partitions.length; i += 1) {
    deps.manager.deserializePartition(i, deserializePayloadV2(bundle.partitions[i]))
  }
  for (const [fieldPath, payload] of Object.entries(bundle.vectorIndexes)) {
    const vecIndex = deps.vectorIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.deserialize(payload)
    }
  }
  return bundle.checkpoint
}

export async function loadSnapshot(
  directory: DurableDirectory,
  indexName: string,
  deps: ReplayDeps,
): Promise<PartitionCheckpoint[]> {
  const bytes = await directory.read(`${indexName}/snapshot`)
  if (bytes === null) {
    return []
  }
  return loadSnapshotBundleBytes(bytes, deps)
}

function segmentStartSeqNo(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix)) {
    return null
  }
  const tail = key.slice(prefix.length)
  if (!/^\d{16}$/.test(tail)) {
    return null
  }
  const value = Number.parseInt(tail, 10)
  return Number.isSafeInteger(value) ? value : null
}

export async function replayWal(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  deps: ReplayDeps,
): Promise<{ highestSeqNo: number; highestPrimaryTerm: number }> {
  const prefix = `${indexName}/wal/${partitionId}/`
  const markerBytes = await directory.read(`${prefix}commit`)
  const marker = markerBytes === null ? null : readCommitMarker(markerBytes)

  if (marker === null) {
    return { highestSeqNo: fromSeqNoExclusive, highestPrimaryTerm: 0 }
  }

  const segments = await collectSegments(directory, prefix)
  await deleteOrphanSegments(directory, segments, marker.state.activeSegmentSeqNo)

  let highestSeqNo = fromSeqNoExclusive
  let highestPrimaryTerm = 0
  let highestReadFromWal = 0

  for (const { key, startSeqNo } of segments) {
    if (startSeqNo > marker.state.activeSegmentSeqNo) {
      continue
    }
    const entries = await readSegmentForRecovery(directory, key, startSeqNo, marker.state)
    for (const entry of entries) {
      if (entry.seqNo > highestReadFromWal) {
        highestReadFromWal = entry.seqNo
      }
      if (entry.seqNo <= highestSeqNo) {
        continue
      }
      applyEntry(entry, deps)
      highestSeqNo = entry.seqNo
      if (entry.primaryTerm > highestPrimaryTerm) {
        highestPrimaryTerm = entry.primaryTerm
      }
    }
  }

  if (highestReadFromWal < marker.state.highestDurableSeqNo) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_WAL_CORRUPT,
      'A durable WAL record is missing: the highest recovered seqNo is below the commit marker',
      {
        indexName,
        partitionId,
        highestRead: highestReadFromWal,
        highestDurable: marker.state.highestDurableSeqNo,
      },
    )
  }

  return { highestSeqNo, highestPrimaryTerm }
}

interface SegmentRef {
  key: string
  startSeqNo: number
}

async function collectSegments(directory: DurableDirectory, prefix: string): Promise<SegmentRef[]> {
  const keys = await directory.list(prefix)
  const refs: SegmentRef[] = []
  for (const key of keys) {
    const startSeqNo = segmentStartSeqNo(key, prefix)
    if (startSeqNo !== null) {
      refs.push({ key, startSeqNo })
    }
  }
  refs.sort((a, b) => a.startSeqNo - b.startSeqNo)
  return refs
}

async function deleteOrphanSegments(
  directory: DurableDirectory,
  segments: SegmentRef[],
  activeSegmentSeqNo: number,
): Promise<void> {
  for (const { key, startSeqNo } of segments) {
    if (startSeqNo > activeSegmentSeqNo) {
      await directory.remove(key)
    }
  }
}

async function readSegmentForRecovery(
  directory: DurableDirectory,
  key: string,
  startSeqNo: number,
  marker: CommitMarkerState,
): Promise<ReplicationLogEntry[]> {
  const bytes = await directory.read(key)
  if (bytes === null) {
    return []
  }

  if (startSeqNo < marker.activeSegmentSeqNo) {
    const header = checkSegmentHeader(bytes)
    if (!header.ok) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_WAL_CORRUPT, `Sealed WAL segment header invalid: ${header.reason}`, {
        key,
        reason: header.reason,
      })
    }
    return readDurableRegion(bytes, bytes.length)
  }

  const entries = readDurableRegion(bytes, marker.durableByteLength)
  if (marker.durableByteLength < bytes.length) {
    await truncateSegmentTail(directory, key, marker.durableByteLength)
  }
  return entries
}

async function truncateSegmentTail(directory: DurableDirectory, key: string, durableByteLength: number): Promise<void> {
  const cleanLength = Math.max(durableByteLength, SEGMENT_HEADER_SIZE)
  const handle = await directory.appendHandle(key)
  try {
    const currentSize = await handle.size()
    if (cleanLength < currentSize) {
      await handle.truncate(cleanLength)
    }
  } finally {
    await handle.close()
  }
}

function applyEntry(entry: ReplicationLogEntry, deps: ReplayDeps): void {
  if (entry.operation === 'DELETE') {
    applyDeleteEntry(entry, deps.manager, deps.vectorIndexes)
    return
  }
  applyIndexEntry(entry, deps.manager, deps.vectorFieldPaths, deps.vectorIndexes)
}

export function snapshotCheckpointFor(checkpoint: PartitionCheckpoint[], partitionId: number): number {
  return checkpointLastSeqNo(checkpoint, partitionId)
}
