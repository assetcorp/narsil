import type { SegmentPayload } from '../../core/partition/segment-payload'
import type { AnyDocument } from '../../types/schema'
import type { WorkerAction } from '../../workers/protocol'
import type { OrchestratorState } from './types'

export interface SegmentBuildRequest {
  partitionId: number
  action: Extract<WorkerAction, { type: 'buildSegment' }>
  documents: AnyDocument[]
}

export interface BuiltSegment {
  partitionId: number
  payload: SegmentPayload
  documents: AnyDocument[]
}

export function segmentBuildConcurrency(state: OrchestratorState, indexName: string): number {
  if (!state.scaledOutIndexes.has(indexName)) return 0
  return state.workerPool?.workerCount ?? 0
}

export async function buildSegments(
  state: OrchestratorState,
  requests: SegmentBuildRequest[],
): Promise<BuiltSegment[] | null> {
  const pool = state.workerPool
  if (!pool || requests.length === 0) return null

  const executors = pool.getAllExecutors()
  if (executors.length === 0) return null

  const results = await Promise.all(
    requests.map((request, i) =>
      executors[i % executors.length]
        .execute<SegmentPayload>(request.action)
        .then(payload => ({ partitionId: request.partitionId, payload, documents: request.documents })),
    ),
  )

  return results
}
