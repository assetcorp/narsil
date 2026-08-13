import { fnv1a } from '../../core/hash'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { WorkerOrchestrator } from '../orchestration'
import type { SegmentBuildRequest } from '../orchestration/segments'

export interface SegmentReplicationDeps {
  orchestrator: Pick<WorkerOrchestrator, 'segmentBuildConcurrency' | 'buildSegments' | 'replicateToWorkers'>
  requireIndex: (indexName: string) => { config: IndexConfig }
  requireManager: (indexName: string) => { partitionCount: number }
}

const MIN_DOCUMENTS_FOR_SEGMENTS = 64

function shardCount(documentCount: number, workers: number): number {
  if (workers <= 1) return 1
  return Math.max(1, Math.min(workers, Math.ceil(documentCount / MIN_DOCUMENTS_FOR_SEGMENTS)))
}

function groupByPartition(docIds: string[], partitionCount: number): Map<number, number[]> {
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

export async function replicateAsSegments(
  ctx: SegmentReplicationDeps,
  indexName: string,
  docIds: string[],
  documents: AnyDocument[],
  skipClone: boolean | undefined,
): Promise<boolean> {
  if (docIds.length < MIN_DOCUMENTS_FOR_SEGMENTS) return false

  const workers = ctx.orchestrator.segmentBuildConcurrency()
  if (workers <= 0) return false

  const entry = ctx.requireIndex(indexName)
  const manager = ctx.requireManager(indexName)
  const groups = groupByPartition(docIds, manager.partitionCount)
  const requests: SegmentBuildRequest[] = []

  for (const [partitionId, indexes] of groups) {
    const shards = shardCount(indexes.length, workers)
    const perShard = Math.ceil(indexes.length / shards)
    for (let start = 0; start < indexes.length; start += perShard) {
      const slice = indexes.slice(start, start + perShard)
      requests.push({
        partitionId,
        action: {
          type: 'buildSegment',
          schema: entry.config.schema,
          language: entry.config.language ?? 'english',
          trackPositions: entry.config.trackPositions ?? true,
          documents: slice.map(i => ({ docId: docIds[i], document: documents[i] })),
          options: skipClone === true ? { skipClone: true } : undefined,
          requestId: `build-segment-${indexName}-${partitionId}-${start}`,
        },
        documents: slice.map(i => documents[i]),
      })
    }
  }

  const built = await ctx.orchestrator.buildSegments(requests)
  if (built === null || built.length === 0) return false

  await ctx.orchestrator.replicateToWorkers({
    type: 'mergeSegments',
    indexName,
    segments: built.map(segment => ({
      partitionId: segment.partitionId,
      payload: segment.payload,
      documents: segment.documents,
    })),
    requestId: `merge-segments-${indexName}-${docIds.length}`,
  })

  return true
}
