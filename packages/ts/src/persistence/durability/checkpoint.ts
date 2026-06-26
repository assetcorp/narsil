import type { PartitionManager } from '../../partitioning/manager'
import type { EnvelopeParts } from '../../serialization/envelope'
import type { VectorIndex, VectorIndexPayload } from '../../vector/vector-index'
import { readCommitMarker } from './commit-marker'
import type { DurableDirectory } from './durable-filesystem'
import { encodeSnapshotBundle, type PartitionCheckpoint } from './snapshot-bundle'

export interface CheckpointInput {
  indexName: string
  schema: Record<string, string>
  language: string
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  seqNoByPartition: Map<number, number>
  primaryTermByPartition: Map<number, number>
}

function snapshotKey(indexName: string): string {
  return `${indexName}/snapshot`
}

function walPrefix(indexName: string, partitionId: number): string {
  return `${indexName}/wal/${partitionId}/`
}

export async function buildSnapshotBundleBytes(
  input: CheckpointInput,
): Promise<{ parts: EnvelopeParts; checkpoint: PartitionCheckpoint[] }> {
  const partitionBuffers: Uint8Array[] = []
  const checkpoint: PartitionCheckpoint[] = []

  for (let i = 0; i < input.manager.partitionCount; i += 1) {
    partitionBuffers.push(input.manager.serializePartitionToBytes(i))
    checkpoint.push({
      partitionId: i,
      lastSeqNo: input.seqNoByPartition.get(i) ?? 0,
      primaryTerm: input.primaryTermByPartition.get(i) ?? 0,
    })
  }

  const vectorPayloads: Record<string, VectorIndexPayload> = {}
  for (const [fieldPath, vecIndex] of input.vectorIndexes) {
    vectorPayloads[fieldPath] = vecIndex.serialize()
  }

  const parts = await encodeSnapshotBundle({
    version: 2,
    schema: input.schema,
    language: input.language,
    partitions: partitionBuffers,
    vectorIndexes: vectorPayloads,
    checkpoint,
  })

  return { parts, checkpoint }
}

export function snapshotStorageKey(indexName: string): string {
  return snapshotKey(indexName)
}

export async function writeCheckpoint(directory: DurableDirectory, input: CheckpointInput): Promise<void> {
  const { parts, checkpoint } = await buildSnapshotBundleBytes(input)
  await directory.atomicWrite(snapshotKey(input.indexName), [parts.header, parts.payload])
  await truncateCoveredSegments(directory, input.indexName, checkpoint)
}

async function truncateCoveredSegments(
  directory: DurableDirectory,
  indexName: string,
  checkpoint: PartitionCheckpoint[],
): Promise<void> {
  for (const { partitionId, lastSeqNo } of checkpoint) {
    const prefix = walPrefix(indexName, partitionId)
    const markerBytes = await directory.read(`${prefix}commit`)
    const marker = markerBytes === null ? null : readCommitMarker(markerBytes)
    if (marker === null) {
      continue
    }
    const activeSegmentSeqNo = marker.state.activeSegmentSeqNo

    const segments = await directory.list(prefix)
    const startSeqNos = segments
      .map(key => parseSegmentStartSeqNo(key, prefix))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)

    for (let i = 0; i < startSeqNos.length; i += 1) {
      const start = startSeqNos[i]
      if (start >= activeSegmentSeqNo) {
        break
      }
      const nextStart = startSeqNos[i + 1]
      const segmentCoversBeyondCheckpoint = nextStart === undefined || nextStart > lastSeqNo + 1
      if (segmentCoversBeyondCheckpoint) {
        break
      }
      await directory.remove(`${prefix}${formatSegmentStart(start)}`)
    }
  }
}

function parseSegmentStartSeqNo(key: string, prefix: string): number | null {
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

function formatSegmentStart(startSeqNo: number): string {
  return startSeqNo.toString().padStart(16, '0')
}
