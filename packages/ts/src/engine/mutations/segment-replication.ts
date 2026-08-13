import { fnv1a } from '../../core/hash'
import { freezeSegmentShared, type SharedSegmentSnapshot } from '../../core/partition/frozen'
import type { SegmentPayload } from '../../core/partition/segment-payload'
import type { AnyDocument } from '../../types/schema'
import type { WorkerOrchestrator } from '../orchestration'
import type { SegmentBuildRequest } from '../orchestration/segments'

export interface SegmentReplicationDeps {
  orchestrator: Pick<WorkerOrchestrator, 'segmentBuildConcurrency' | 'buildSegments' | 'replicateToWorkers'>
  requireManager: (indexName: string) => { partitionCount: number }
}

export const MIN_DOCUMENTS_FOR_SEGMENTS = 64

export function shardCount(documentCount: number, workers: number): number {
  if (workers <= 1) return 1
  return Math.max(1, Math.min(workers, Math.ceil(documentCount / MIN_DOCUMENTS_FOR_SEGMENTS)))
}

export function groupByPartition(docIds: string[], partitionCount: number): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (let i = 0; i < docIds.length; i++) {
    const partitionId = partitionCount <= 1 ? 0 : fnv1a(docIds[i]) % partitionCount
    let group = groups.get(partitionId)
    if (group === undefined) {
      group = []
      groups.set(partitionId, group)
    }
    group.push(i)
  }
  return groups
}

export function buildSegmentRequests(
  indexName: string,
  docIds: string[],
  documents: AnyDocument[],
  partitionCount: number,
  workers: number,
  skipClone: boolean | undefined,
): { requests: SegmentBuildRequest[]; memberIndexes: number[][] } {
  const groups = groupByPartition(docIds, partitionCount)
  const requests: SegmentBuildRequest[] = []
  const memberIndexes: number[][] = []

  for (const [partitionId, indexes] of groups) {
    const shards = shardCount(indexes.length, workers)
    const perShard = Math.ceil(indexes.length / shards)
    for (let start = 0; start < indexes.length; start += perShard) {
      const slice = indexes.slice(start, start + perShard)
      requests.push({
        partitionId,
        action: {
          type: 'buildSegment',
          indexName,
          documents: slice.map(i => ({ docId: docIds[i], document: documents[i] })),
          options: skipClone === true ? { skipClone: true } : undefined,
          requestId: `build-segment-${indexName}-${partitionId}-${start}`,
        },
        documents: slice.map(i => documents[i]),
      })
      memberIndexes.push(slice)
    }
  }

  return { requests, memberIndexes }
}

export interface BroadcastSegment {
  partitionId: number
  payload: SegmentPayload
  documents: AnyDocument[]
}

export function freezeSegmentsForAttach(
  segments: ReadonlyArray<BroadcastSegment>,
): Array<{ partitionId: number; snapshot: SharedSegmentSnapshot }> | null {
  const frozen: Array<{ partitionId: number; snapshot: SharedSegmentSnapshot }> = []
  for (const segment of segments) {
    const snapshot = freezeSegmentShared(segment.payload, segment.documents)
    if (snapshot === null) return null
    frozen.push({ partitionId: segment.partitionId, snapshot })
  }
  return frozen
}

export async function broadcastBuiltSegments(
  orchestrator: Pick<WorkerOrchestrator, 'replicateToWorkers'>,
  indexName: string,
  segments: ReadonlyArray<BroadcastSegment>,
  skipClone: boolean | undefined,
): Promise<void> {
  const frozen = freezeSegmentsForAttach(segments)
  if (frozen !== null) {
    await orchestrator.replicateToWorkers({
      type: 'attachSegments',
      indexName,
      segments: frozen,
      requestId: `attach-segments-${indexName}-${segments.length}`,
    })
    return
  }
  await orchestrator.replicateToWorkers({
    type: 'mergeSegments',
    indexName,
    segments: [...segments],
    requestId: `merge-segments-${indexName}-${segments.length}`,
    skipClone: skipClone === true ? true : undefined,
  })
}

export async function replicateAsSegments(
  ctx: SegmentReplicationDeps,
  indexName: string,
  docIds: string[],
  documents: AnyDocument[],
  skipClone: boolean | undefined,
): Promise<boolean> {
  if (docIds.length < MIN_DOCUMENTS_FOR_SEGMENTS) return false

  const workers = ctx.orchestrator.segmentBuildConcurrency(indexName)
  if (workers <= 0) return false

  const manager = ctx.requireManager(indexName)
  const { requests } = buildSegmentRequests(indexName, docIds, documents, manager.partitionCount, workers, skipClone)

  const built = await ctx.orchestrator.buildSegments(requests)
  if (built === null || built.length === 0) return false

  await broadcastBuiltSegments(
    ctx.orchestrator,
    indexName,
    built.map(segment => ({
      partitionId: segment.partitionId,
      payload: segment.payload,
      documents: segment.documents,
    })),
    skipClone,
  )

  return true
}
