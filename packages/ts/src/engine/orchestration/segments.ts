import { generateId } from '../../core/id-generator'
import type { SharedSegmentSnapshot } from '../../core/partition/frozen'
import type { SegmentPayload } from '../../core/partition/segment-payload'
import type { AnyDocument } from '../../types/schema'
import type { BuiltSegmentResult, WorkerAction } from '../../workers/protocol'
import type { OrchestratorState } from './types'

export interface SegmentBuildRequest {
  partitionId: number
  action: Extract<WorkerAction, { type: 'buildSegment' }>
  documents: AnyDocument[]
}

export interface BuiltSegment {
  partitionId: number
  segmentId: string
  snapshot: SharedSegmentSnapshot | null
  payload: SegmentPayload | null
  documents: AnyDocument[]
  docIds: string[]
}

export function segmentBuildConcurrency(state: OrchestratorState, indexName: string): number {
  if (!state.scaledOutIndexes.has(indexName)) return 0
  return state.workerPool?.workerCount ?? 0
}

function builtSegmentsOf(request: SegmentBuildRequest, results: BuiltSegmentResult[]): BuiltSegment[] {
  let start = 0
  return results.map(result => {
    const count = result.kind === 'shared' ? result.snapshot.documentCount : result.payload.documentCount
    const segmentId =
      result.kind === 'shared' ? result.snapshot.segmentId : start === 0 ? request.action.segmentId : generateId()
    const base = {
      partitionId: request.partitionId,
      segmentId,
      documents: request.documents.slice(start, start + count),
      docIds: request.action.documents.slice(start, start + count).map(document => document.docId),
    }
    start += count
    if (result.kind === 'shared') return { ...base, snapshot: result.snapshot, payload: null }
    return { ...base, snapshot: null, payload: result.payload }
  })
}

export async function buildSegments(
  state: OrchestratorState,
  requests: SegmentBuildRequest[],
): Promise<BuiltSegment[] | null> {
  const pool = state.workerPool
  if (!pool || requests.length === 0) return null

  const leases = requests.map(() => pool.leaseLeastBusy())
  if (leases.some(lease => lease === null)) {
    for (const lease of leases) lease?.release()
    return null
  }

  try {
    const outputs = await Promise.all(
      requests.map((request, i) => {
        const lease = leases[i]
        if (lease === null) throw new Error('Segment build lease missing')
        return lease.executor
          .execute<BuiltSegmentResult[]>(request.action)
          .then(result => builtSegmentsOf(request, result))
      }),
    )
    return outputs.flat()
  } finally {
    for (const lease of leases) lease?.release()
  }
}
