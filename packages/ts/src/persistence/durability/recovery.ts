import { turnIsSpent, yieldTurn } from '#platform/storage-host'
import { applyDeleteEntry, applyIndexEntry } from '../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { noteDocumentChurn } from '../../engine/memory/document-churn'
import type { PartitionManager } from '../../partitioning/manager'
import { readMetadataEnvelope } from '../../serialization/envelope'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'
import type { DurableDirectory } from './durable-filesystem'
import { createMarkerWriter } from './marker-writer'
import { checkpointLastSeqNo, type PartitionCheckpoint } from './partition-checkpoint'
import type { WriteRecordKeeper } from './types'
import { SEGMENT_HEADER_SIZE } from './wal-framing'
import {
  type ActiveTail,
  type CommitMarker,
  durableRecordMissing,
  readWalSegments,
  removeUnusedSegmentFiles,
  type SegmentRef,
  type WalReadResult,
} from './wal-segments'

export interface RecoveredIndex {
  metadata: IndexMetadata
  highestSeqNoByPartition: Map<number, number>
  primaryTermByPartition: Map<number, number>
}

export interface ReplayDeps {
  manager: PartitionManager
  vectorFieldPaths: Set<string>
  vectorIndexes: Map<string, VectorIndex>
  writeRecords?: WriteRecordKeeper | null
  defersGraphBuilds?: boolean
}

export async function removeLeftoverRewriteFiles(directory: DurableDirectory, names: readonly string[]): Promise<void> {
  for (const indexName of names) {
    for (const place of ['rebuilt', 'received']) {
      for (const key of await directory.list(`${indexName}/${place}/`)) await directory.remove(key)
    }
  }
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

export async function replayWal(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  deps: ReplayDeps,
): Promise<{ highestSeqNo: number; highestPrimaryTerm: number }> {
  await removeUnusedSegmentFiles(directory, indexName, partitionId)
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
  const replay = async (entries: ReplicationLogEntry[]): Promise<void> => {
    for (const entry of entries) {
      if (entry.seqNo <= highestSeqNo) {
        continue
      }
      if (turnIsSpent()) await yieldTurn()
      applyEntry(entry, deps)
      highestSeqNo = entry.seqNo
      if (entry.primaryTerm > highestPrimaryTerm) {
        highestPrimaryTerm = entry.primaryTerm
      }
    }
  }
  await replay(durableEntries)
  if (activeTail !== null) {
    await replay(activeTail.entries)
  }

  await deleteOrphanSegments(directory, segments, marker.state.activeSegmentSeqNo)
  if (activeTail !== null) {
    await makeReplayedTailDurable(directory, indexName, partitionId, marker, activeTail)
  }

  return { highestSeqNo, highestPrimaryTerm }
}

async function makeReplayedTailDurable(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  marker: CommitMarker,
  tail: ActiveTail,
): Promise<void> {
  const lastReplayed = tail.entries.at(-1)
  if (lastReplayed === undefined && tail.cleanEnd >= tail.segmentLength) return
  const handle = await directory.appendHandle(tail.key)
  try {
    if (tail.cleanEnd < (await handle.size())) await handle.truncate(tail.cleanEnd)
    else await handle.sync()
  } finally {
    await handle.close()
  }
  if (lastReplayed === undefined) return
  const writer = await createMarkerWriter(directory, indexName, partitionId)
  try {
    await writer.commit({
      activeSegmentSeqNo: marker.state.activeSegmentSeqNo,
      durableByteLength: tail.cleanEnd,
      highestDurableSeqNo: Math.max(marker.state.highestDurableSeqNo, lastReplayed.seqNo),
    })
  } finally {
    await writer.close()
  }
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
  return replayDurableEntries(read, indexName, partitionId, fromSeqNoExclusive, upToSeqNoInclusive, deps)
}

export async function replaySyncedWal(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  deps: ReplayDeps,
): Promise<{ highestSeqNo: number; highestPrimaryTerm: number }> {
  await removeUnusedSegmentFiles(directory, indexName, partitionId)
  const read = await readWalSegments(directory, indexName, partitionId)
  if (read === null) {
    return { highestSeqNo: fromSeqNoExclusive, highestPrimaryTerm: 0 }
  }
  const replayed = replayDurableEntries(
    read,
    indexName,
    partitionId,
    fromSeqNoExclusive,
    Number.POSITIVE_INFINITY,
    deps,
  )
  await deleteOrphanSegments(directory, read.segments, read.marker.state.activeSegmentSeqNo)
  if (read.activeTail !== null) {
    await truncateSegmentTail(directory, read.activeTail.key, read.marker.state.durableByteLength)
  }
  return replayed
}

function replayDurableEntries(
  read: WalReadResult,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  upToSeqNoInclusive: number,
  deps: ReplayDeps,
): { highestSeqNo: number; highestPrimaryTerm: number } {
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
  deps.writeRecords?.replayed(entry)
  if (entry.operation === 'DELETE' || deps.manager.has(entry.documentId)) noteDocumentChurn(entry.indexName, 1)
  if (entry.operation === 'DELETE') {
    applyDeleteEntry(entry, deps.manager, deps.vectorIndexes)
    return
  }
  applyIndexEntry(entry, deps.manager, deps.vectorFieldPaths, deps.vectorIndexes, deps.defersGraphBuilds !== true)
}

export function snapshotCheckpointFor(checkpoint: PartitionCheckpoint[], partitionId: number): number {
  return checkpointLastSeqNo(checkpoint, partitionId)
}
