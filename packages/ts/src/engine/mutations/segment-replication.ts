import { fnv1a } from '../../core/hash'
import { generateId } from '../../core/id-generator'
import { freezeSegmentShared, type SharedSegmentSnapshot } from '../../core/partition/frozen'
import type { AnyDocument } from '../../types/schema'
import type { WorkerAction } from '../../workers/protocol'
import type { BuiltSegment, SegmentBuildRequest } from '../orchestration/segments'

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

function sharedSnapshotOf(segment: BuiltSegment): SharedSegmentSnapshot | null {
  if (segment.snapshot !== null) return segment.snapshot
  if (segment.payload === null) return null
  try {
    return freezeSegmentShared(segment.payload, segment.documents, segment.segmentId)
  } catch (err) {
    console.warn('Segment freeze failed, replicating by merge instead:', err)
    return null
  }
}

export function copyActionOfSegment(
  indexName: string,
  segment: BuiltSegment,
  skipClone: boolean | undefined,
): WorkerAction | null {
  const snapshot = sharedSnapshotOf(segment)
  if (snapshot !== null) {
    return {
      type: 'attachSegments',
      indexName,
      segments: [{ partitionId: segment.partitionId, snapshot }],
      requestId: `attach-segments-${indexName}-${segment.segmentId}`,
    }
  }
  if (segment.payload === null) return null
  return {
    type: 'mergeSegments',
    indexName,
    segments: [{ partitionId: segment.partitionId, payload: segment.payload, documents: segment.documents }],
    requestId: `merge-segments-${indexName}-${segment.segmentId}`,
    skipClone: skipClone === true ? true : undefined,
  }
}
