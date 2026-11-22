import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import type { WriteRoutingDeps } from './types'

interface LeadingPartition {
  table: AllocationTable
  assignment: PartitionAssignment & { primary: string }
}

export function initialisingHere(assignment: PartitionAssignment | undefined, nodeId: string): boolean {
  return assignment?.primary === nodeId && assignment.state === 'INITIALISING'
}

export function refusedWhileInitialising(error: unknown): boolean {
  return (
    error instanceof NarsilError &&
    error.code === ErrorCodes.PARTITION_NOT_PRIMARY &&
    error.details.state === 'INITIALISING'
  )
}

function initialisingRefusal(deps: WriteRoutingDeps, indexName: string, partitionId: number): NarsilError {
  return new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Node '${deps.nodeId}' takes no write for partition ${partitionId} of index '${indexName}' until the partition is ACTIVE`,
    { indexName, partitionId, primaryNodeId: deps.nodeId, localNodeId: deps.nodeId, state: 'INITIALISING' },
  )
}

export async function liveWritablePartition(
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
): Promise<LeadingPartition> {
  let live: AllocationTable | null
  try {
    live = await (deps.readLiveAllocation?.(indexName) ?? deps.coordinator.getAllocation(indexName))
  } catch (_) {
    throw initialisingRefusal(deps, indexName, partitionId)
  }
  const assignment = live?.assignments.get(partitionId)
  if (initialisingHere(assignment, deps.nodeId)) throw initialisingRefusal(deps, indexName, partitionId)
  if (live === null || assignment === undefined || assignment.primary !== deps.nodeId) {
    throw new NarsilError(
      ErrorCodes.PARTITION_NOT_PRIMARY,
      `Node '${deps.nodeId}' no longer leads partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId, primaryNodeId: assignment?.primary ?? null, localNodeId: deps.nodeId },
    )
  }
  return { table: live, assignment: { ...assignment, primary: deps.nodeId } }
}

export async function writableAssignment<T extends PartitionAssignment>(
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  watched: T,
): Promise<T | LeadingPartition['assignment']> {
  if (!initialisingHere(watched, deps.nodeId)) return watched
  return (await liveWritablePartition(deps, indexName, partitionId)).assignment
}
