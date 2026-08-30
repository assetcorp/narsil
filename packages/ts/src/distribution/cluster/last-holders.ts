import type { PartitionAssignment } from '../coordinator/types'

/**
 * Reads the nodes that still hold a copy of a partition no node serves.
 *
 * The controller writes this record when it moves a partition to `UNASSIGNED`, and it keeps the record through a
 * promotion until the partition reaches `ACTIVE`, so a promoted node that fails part way through leaves the other
 * holders on record. A served partition carries no record, and this function then reports an empty list.
 *
 * @param assignment - The partition assignment the coordinator holds.
 * @returns The node ids of the last holders, which is empty where the partition needs no recovery.
 */
export function lastHoldersOf(assignment: PartitionAssignment): string[] {
  return assignment.lastHolders ?? []
}

/**
 * Reports whether one node still holds a copy the controller may give a partition back to.
 *
 * A node this reports true for keeps its copy of the partition and answers for it, because the controller asks the
 * last holders before it gives an unserved partition back to one of them.
 *
 * @param assignment - The partition assignment the coordinator holds.
 * @param nodeId - The node to test against the record.
 * @returns True where the record names the node.
 */
export function holdsLastCopy(assignment: PartitionAssignment, nodeId: string): boolean {
  return lastHoldersOf(assignment).includes(nodeId)
}
