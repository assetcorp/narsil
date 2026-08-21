import { type ErrorCode, ErrorCodes } from '../../errors'
import type { AllocationTable, ClusterCoordinator, PartitionState } from '../coordinator/types'

export type SnapshotAuthOutcome = { outcome: 'authorized' } | { outcome: 'denied'; code: ErrorCode; reason: string }

const BOOTSTRAPPABLE_STATES = new Set<PartitionState>(['ACTIVE', 'INITIALISING', 'MIGRATING'])

export async function authorizeSnapshotRequest(
  coordinator: ClusterCoordinator,
  indexName: string,
  sourceId: string,
): Promise<SnapshotAuthOutcome> {
  let allocation: AllocationTable | null
  try {
    allocation = await coordinator.getAllocation(indexName)
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    return {
      outcome: 'denied',
      code: ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
      reason: `allocation lookup failed: ${errMessage}`,
    }
  }

  if (allocation === null) {
    return {
      outcome: 'denied',
      code: ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED,
      reason: `index '${indexName}' has no allocation`,
    }
  }

  let sawAssignment = false
  for (const assignment of allocation.assignments.values()) {
    const isAssigned = assignment.primary === sourceId || assignment.replicas.includes(sourceId)

    if (!isAssigned) {
      continue
    }
    sawAssignment = true

    if (!BOOTSTRAPPABLE_STATES.has(assignment.state)) {
      continue
    }

    return { outcome: 'authorized' }
  }

  if (sawAssignment) {
    return {
      outcome: 'denied',
      code: ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED,
      reason: `node '${sourceId}' is listed for index '${indexName}' but not in a bootstrappable state`,
    }
  }

  return {
    outcome: 'denied',
    code: ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED,
    reason: `node '${sourceId}' is not an assigned replica for index '${indexName}'`,
  }
}
