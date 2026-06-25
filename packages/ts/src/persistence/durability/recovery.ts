import { applyDeleteEntry, applyIndexEntry } from '../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import type { PartitionManager } from '../../partitioning/manager'
import { readMetadataEnvelope } from '../../serialization/envelope'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'
import type { DurableDirectory } from './durable-filesystem'
import { checkpointLastSeqNo, decodeSnapshotBundle, type PartitionCheckpoint } from './snapshot-bundle'
import { readSegment } from './wal-framing'

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

export async function loadSnapshot(
  directory: DurableDirectory,
  indexName: string,
  deps: ReplayDeps,
): Promise<PartitionCheckpoint[]> {
  const bytes = await directory.read(`${indexName}/snapshot`)
  if (bytes === null) {
    return []
  }
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

export async function replayWal(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  deps: ReplayDeps,
): Promise<{ highestSeqNo: number; highestPrimaryTerm: number }> {
  const prefix = `${indexName}/wal/${partitionId}/`
  const segments = (await directory.list(prefix)).sort()

  let highestSeqNo = fromSeqNoExclusive
  let highestPrimaryTerm = 0

  for (const segmentKey of segments) {
    const bytes = await directory.read(segmentKey)
    if (bytes === null) {
      continue
    }
    const result = readSegment(bytes)
    if (result.kind === 'header-invalid') {
      continue
    }
    for (const entry of result.entries) {
      if (entry.seqNo <= highestSeqNo) {
        continue
      }
      applyEntry(entry, deps)
      highestSeqNo = entry.seqNo
      if (entry.primaryTerm > highestPrimaryTerm) {
        highestPrimaryTerm = entry.primaryTerm
      }
    }
    if (result.truncated) {
      await truncateTornSegment(directory, segmentKey, result.cleanByteLength)
    }
  }

  return { highestSeqNo, highestPrimaryTerm }
}

function applyEntry(entry: ReplicationLogEntry, deps: ReplayDeps): void {
  if (entry.operation === 'DELETE') {
    applyDeleteEntry(entry, deps.manager, deps.vectorIndexes)
    return
  }
  applyIndexEntry(entry, deps.manager, deps.vectorFieldPaths, deps.vectorIndexes)
}

async function truncateTornSegment(
  directory: DurableDirectory,
  segmentKey: string,
  cleanByteLength: number,
): Promise<void> {
  const handle = await directory.appendHandle(segmentKey)
  try {
    const currentSize = await handle.size()
    if (cleanByteLength < currentSize) {
      await handle.truncate(cleanByteLength)
    }
  } finally {
    await handle.close()
  }
}

export function snapshotCheckpointFor(checkpoint: PartitionCheckpoint[], partitionId: number): number {
  return checkpointLastSeqNo(checkpoint, partitionId)
}
