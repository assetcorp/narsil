import { applyDeleteEntry, applyIndexEntry } from '../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import type { PartitionManager } from '../../partitioning/manager'
import { readMetadataEnvelope } from '../../serialization/envelope'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'
import type { DurableDirectory } from './durable-filesystem'
import { loadSegmentedSnapshot, readSegmentManifest } from './segment'
import { checkpointLastSeqNo, decodeSnapshotBundle, type PartitionCheckpoint } from './snapshot-bundle'
import { SEGMENT_HEADER_SIZE } from './wal-framing'
import { durableRecordMissing, readWalSegments, type SegmentRef } from './wal-segments'

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
  if (bundle.partitions.length > 0) {
    deps.manager.trimPartitions(bundle.partitions.length)
  }
  for (let i = 0; i < bundle.partitions.length; i += 1) {
    deps.manager.deserializePartition(i, deserializePayloadV2(bundle.partitions[i]))
  }
  for (const [fieldPath, parts] of Object.entries(bundle.vectorIndexes)) {
    const vecIndex = deps.vectorIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.deserialize(parts)
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
  if (manifest === null) {
    return []
  }
  return loadSegmentedSnapshot(directory, indexName, manifest, deps)
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
    throw durableRecordMissing(indexName, partitionId, highestReadFromWal, marker)
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
    throw durableRecordMissing(indexName, partitionId, read.highestReadFromWal, read.marker)
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
