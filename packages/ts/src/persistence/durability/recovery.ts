import { applyDeleteEntry, applyIndexEntry } from '../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { readMetadataEnvelope } from '../../serialization/envelope'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'
import { readCommitMarker } from './commit-marker'
import type { DurableDirectory } from './durable-filesystem'
import { loadSegmentedSnapshot, readSegmentManifest } from './segment'
import { checkpointLastSeqNo, decodeSnapshotBundle, type PartitionCheckpoint } from './snapshot-bundle'
import { checkSegmentHeader, readDurableRegion, readTailBeyondFrontier, SEGMENT_HEADER_SIZE } from './wal-framing'

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
  const manifest = await readSegmentManifest(directory, indexName)
  if (manifest !== null) {
    return loadSegmentedSnapshot(directory, indexName, manifest, deps)
  }
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

interface ActiveTail {
  key: string
  entries: ReplicationLogEntry[]
  cleanEnd: number
  segmentLength: number
}

type CommitMarker = NonNullable<ReturnType<typeof readCommitMarker>>

interface WalReadResult {
  marker: CommitMarker
  segments: SegmentRef[]
  durableEntries: ReplicationLogEntry[]
  activeTail: ActiveTail | null
  highestReadFromWal: number
}

async function readWalSegments(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
): Promise<WalReadResult | null> {
  const prefix = `${indexName}/wal/${partitionId}/`
  const markerBytes = await directory.read(`${prefix}commit`)
  const marker = markerBytes === null ? null : readCommitMarker(markerBytes)

  if (marker === null) {
    return null
  }

  const segments = await collectSegments(directory, prefix)

  const durableEntries: ReplicationLogEntry[] = []
  let highestReadFromWal = 0
  let activeTail: ActiveTail | null = null

  for (const { key, startSeqNo } of segments) {
    if (startSeqNo > marker.state.activeSegmentSeqNo) {
      continue
    }
    const bytes = await directory.read(key)
    if (bytes === null) {
      continue
    }

    if (startSeqNo < marker.state.activeSegmentSeqNo) {
      const header = checkSegmentHeader(bytes)
      if (!header.ok) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_WAL_CORRUPT,
          `Sealed WAL segment header invalid: ${header.reason}`,
          {
            key,
            reason: header.reason,
          },
        )
      }
      for (const entry of readDurableRegion(bytes, bytes.length)) {
        durableEntries.push(entry)
        if (entry.seqNo > highestReadFromWal) {
          highestReadFromWal = entry.seqNo
        }
      }
      continue
    }

    for (const entry of readDurableRegion(bytes, marker.state.durableByteLength)) {
      durableEntries.push(entry)
      if (entry.seqNo > highestReadFromWal) {
        highestReadFromWal = entry.seqNo
      }
    }
    const tail = readTailBeyondFrontier(
      bytes,
      marker.state.durableByteLength,
      Math.max(highestReadFromWal, marker.state.highestDurableSeqNo),
    )
    activeTail = { key, entries: tail.entries, cleanEnd: tail.cleanEnd, segmentLength: bytes.length }
  }

  return { marker, segments, durableEntries, activeTail, highestReadFromWal }
}

export async function replayWal(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  deps: ReplayDeps,
): Promise<{ highestSeqNo: number; highestPrimaryTerm: number }> {
  const read = await readWalSegments(directory, indexName, partitionId)
  if (read === null) {
    return { highestSeqNo: fromSeqNoExclusive, highestPrimaryTerm: 0 }
  }
  const { marker, segments, durableEntries, activeTail, highestReadFromWal } = read

  if (Math.max(fromSeqNoExclusive, highestReadFromWal) < marker.state.highestDurableSeqNo) {
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

  let highestSeqNo = fromSeqNoExclusive
  let highestPrimaryTerm = 0
  const replay = (entries: ReplicationLogEntry[]): void => {
    for (const entry of entries) {
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
  replay(durableEntries)
  if (activeTail !== null) {
    replay(activeTail.entries)
  }

  await deleteOrphanSegments(directory, segments, marker.state.activeSegmentSeqNo)
  if (activeTail !== null && activeTail.cleanEnd < activeTail.segmentLength) {
    await truncateSegmentTail(directory, activeTail.key, activeTail.cleanEnd)
  }

  return { highestSeqNo, highestPrimaryTerm }
}

export async function replayWalUpTo(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  upToSeqNoInclusive: number,
  deps: ReplayDeps,
): Promise<{ highestSeqNo: number; highestPrimaryTerm: number }> {
  const read = await readWalSegments(directory, indexName, partitionId)
  if (read === null) {
    return { highestSeqNo: fromSeqNoExclusive, highestPrimaryTerm: 0 }
  }

  if (Math.max(fromSeqNoExclusive, read.highestReadFromWal) < read.marker.state.highestDurableSeqNo) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_WAL_CORRUPT,
      'A durable WAL record is missing: the highest recovered seqNo is below the commit marker',
      {
        indexName,
        partitionId,
        highestRead: read.highestReadFromWal,
        highestDurable: read.marker.state.highestDurableSeqNo,
      },
    )
  }

  let highestSeqNo = fromSeqNoExclusive
  let highestPrimaryTerm = 0
  for (const entry of read.durableEntries) {
    if (entry.seqNo <= fromSeqNoExclusive || entry.seqNo > upToSeqNoInclusive) {
      continue
    }
    applyEntry(entry, deps)
    if (entry.seqNo > highestSeqNo) {
      highestSeqNo = entry.seqNo
    }
    if (entry.primaryTerm > highestPrimaryTerm) {
      highestPrimaryTerm = entry.primaryTerm
    }
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

export async function collectWalEntriesInRange(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  upToSeqNoInclusive: number,
): Promise<ReplicationLogEntry[]> {
  const read = await readWalSegments(directory, indexName, partitionId)
  if (read === null) {
    return []
  }

  if (Math.max(fromSeqNoExclusive, read.highestReadFromWal) < read.marker.state.highestDurableSeqNo) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_WAL_CORRUPT,
      'A durable WAL record is missing: the highest recovered seqNo is below the commit marker',
      {
        indexName,
        partitionId,
        highestRead: read.highestReadFromWal,
        highestDurable: read.marker.state.highestDurableSeqNo,
      },
    )
  }

  const entries: ReplicationLogEntry[] = []
  for (const entry of read.durableEntries) {
    if (entry.seqNo <= fromSeqNoExclusive || entry.seqNo > upToSeqNoInclusive) {
      continue
    }
    entries.push(entry)
  }
  return entries
}
