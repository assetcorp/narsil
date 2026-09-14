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
}

export function segmentBuildConcurrency(state: OrchestratorState, indexName: string): number {
  if (!state.scaledOutIndexes.has(indexName)) return 0
  return state.workerPool?.workerCount ?? 0
}

function builtSegmentOf(request: SegmentBuildRequest, result: BuiltSegmentResult): BuiltSegment {
  const base = { partitionId: request.partitionId, segmentId: request.action.segmentId, documents: request.documents }
  if (result.kind === 'shared') return { ...base, snapshot: result.snapshot, payload: null }
  return { ...base, snapshot: null, payload: result.payload }
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
    return await Promise.all(
      requests.map((request, i) => {
        const lease = leases[i]
        if (lease === null) throw new Error('Segment build lease missing')
        return lease.executor
          .execute<BuiltSegmentResult>(request.action)
          .then(result => builtSegmentOf(request, result))
      }),
    )
  } finally {
    for (const lease of leases) lease?.release()
  }
}
