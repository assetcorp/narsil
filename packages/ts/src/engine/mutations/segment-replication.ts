import { fnv1a } from '../../core/hash'
import { generateId } from '../../core/id-generator'
import { freezeSegmentShared, type SharedSegmentSnapshot } from '../../core/partition/frozen'
import type { AnyDocument } from '../../types/schema'
import { MIN_DOCUMENTS_FOR_SEGMENTS } from '../constants'
import type { WorkerOrchestrator } from '../orchestration'
import type { BuiltSegment, SegmentBuildRequest } from '../orchestration/segments'

export interface SegmentReplicationDeps {
  orchestrator: Pick<WorkerOrchestrator, 'segmentBuildConcurrency' | 'buildSegments' | 'replicateToWorkers'>
  requireManager: (indexName: string) => { partitionCount: number }
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
  skipClone: boolean | undefined,
): { requests: SegmentBuildRequest[]; memberIndexes: number[][] } {
  const groups = groupByPartition(docIds, partitionCount)
  const requests: SegmentBuildRequest[] = []
  const memberIndexes: number[][] = []

  for (const [partitionId, indexes] of groups) {
    requests.push({
      partitionId,
      action: {
        type: 'buildSegment',
        indexName,
        segmentId: generateId(),
        documents: indexes.map(i => ({ docId: docIds[i], document: documents[i] })),
        options: skipClone === true ? { skipClone: true } : undefined,
        requestId: `build-segment-${indexName}-${partitionId}`,
      },
      documents: indexes.map(i => documents[i]),
    })
    memberIndexes.push(indexes)
  }

  return { requests, memberIndexes }
}

export interface AttachableSegment {
  partitionId: number
  snapshot: SharedSegmentSnapshot
}

export function freezeSegmentsForAttach(segments: ReadonlyArray<BuiltSegment>): AttachableSegment[] | null {
  const frozen: AttachableSegment[] = []
  for (const segment of segments) {
    const snapshot =
      segment.snapshot ??
      (segment.payload === null ? null : freezeSegmentShared(segment.payload, segment.documents, segment.segmentId))
    if (snapshot === null) return null
    frozen.push({ partitionId: segment.partitionId, snapshot })
  }
  return frozen
}

function tryFreezeSegmentsForAttach(segments: ReadonlyArray<BuiltSegment>): AttachableSegment[] | null {
  try {
    return freezeSegmentsForAttach(segments)
  } catch (err) {
    console.warn('Segment freeze failed, replicating by merge instead:', err)
    return null
  }
}

function payloadSegments(segments: ReadonlyArray<BuiltSegment>) {
  const plain: Array<{ partitionId: number; payload: NonNullable<BuiltSegment['payload']>; documents: AnyDocument[] }> =
    []
  for (const segment of segments) {
    if (segment.payload !== null) {
      plain.push({ partitionId: segment.partitionId, payload: segment.payload, documents: segment.documents })
    }
  }
  return plain
}

function snapshotSegments(segments: ReadonlyArray<BuiltSegment>): AttachableSegment[] {
  const shared: AttachableSegment[] = []
  for (const segment of segments) {
    if (segment.snapshot !== null) shared.push({ partitionId: segment.partitionId, snapshot: segment.snapshot })
  }
  return shared
}

function attachSegments(
  orchestrator: Pick<WorkerOrchestrator, 'replicateToWorkers'>,
  indexName: string,
  segments: AttachableSegment[],
): Promise<void> {
  return orchestrator.replicateToWorkers({
    type: 'attachSegments',
    indexName,
    segments,
    requestId: `attach-segments-${indexName}-${segments.length}`,
  })
}

export async function broadcastBuiltSegments(
  orchestrator: Pick<WorkerOrchestrator, 'replicateToWorkers'>,
  indexName: string,
  segments: ReadonlyArray<BuiltSegment>,
  skipClone: boolean | undefined,
): Promise<void> {
  const frozen = tryFreezeSegmentsForAttach(segments)
  if (frozen !== null) {
    await attachSegments(orchestrator, indexName, frozen)
    return
  }
  const shared = snapshotSegments(segments)
  if (shared.length > 0) await attachSegments(orchestrator, indexName, shared)
  const plain = payloadSegments(segments)
  if (plain.length === 0) return
  await orchestrator.replicateToWorkers({
    type: 'mergeSegments',
    indexName,
    segments: plain,
    requestId: `merge-segments-${indexName}-${plain.length}`,
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
  const { requests } = buildSegmentRequests(indexName, docIds, documents, manager.partitionCount, skipClone)

  const built = await ctx.orchestrator.buildSegments(requests)
  if (built === null || built.length === 0) return false

  await broadcastBuiltSegments(ctx.orchestrator, indexName, built, skipClone)

  return true
}
