import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLog } from '../../replication/types'
import type { WriteRoutingDeps } from '../write-routing'

export async function leadingAssignment(
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
): Promise<PartitionAssignment> {
  let assignment = (await deps.coordinator.getAllocation(indexName))?.assignments.get(partitionId)
  if (assignment?.primary !== deps.nodeId && deps.refreshAllocation !== undefined) {
    assignment = (await deps.refreshAllocation(indexName))?.assignments.get(partitionId)
  }
  if (assignment === undefined || assignment.primary !== deps.nodeId) {
    throw new NarsilError(
      ErrorCodes.PARTITION_NOT_PRIMARY,
      `Node '${deps.nodeId}' does not lead partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId, primaryNodeId: assignment?.primary ?? null, localNodeId: deps.nodeId },
    )
  }
  return assignment
}

export function forwardableEnd(log: ReplicationLog, primaryTerm: number): number {
  let end = log.commitPoint
  for (;;) {
    const next = log.getEntry(end + 1)
    if (next === undefined || next.primaryTerm >= primaryTerm) return end
    end = next.seqNo
  }
}
