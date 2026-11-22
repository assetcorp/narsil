import { keepRemovingReplicasHeld, markUnassigned, neverReachedActive } from './lost-nodes'
import type { PartitionAssignment } from './types'

function withoutDeparted(
  assignment: PartitionAssignment,
  registeredNodeIds: ReadonlySet<string>,
  retainedNodeIds: ReadonlySet<string>,
): PartitionAssignment | null {
  if (assignment.state === 'UNASSIGNED') return null

  const { primary } = assignment
  if (primary === null || !registeredNodeIds.has(primary)) {
    if (primary !== null && neverReachedActive(assignment)) return null
    const unassigned: PartitionAssignment = { ...assignment }
    if (assignment.state !== 'INITIALISING') delete unassigned.lastHolders
    markUnassigned(unassigned, primary, assignment.inSyncSet)
    return unassigned
  }

  const inSyncSet = assignment.inSyncSet.filter(id => registeredNodeIds.has(id))
  const replicas = assignment.replicas.filter(id => registeredNodeIds.has(id) || retainedNodeIds.has(id))
  if (inSyncSet.length === assignment.inSyncSet.length && replicas.length === assignment.replicas.length) return null
  const reduced: PartitionAssignment = { ...assignment, inSyncSet, replicas }
  keepRemovingReplicasHeld(reduced)
  return reduced
}

export function assignmentsWithoutDepartedNodes(
  assignments: ReadonlyMap<number, PartitionAssignment>,
  registeredNodeIds: ReadonlySet<string>,
  retainedNodeIds: ReadonlySet<string>,
): Map<number, PartitionAssignment> | null {
  let changed: Map<number, PartitionAssignment> | null = null
  for (const [partitionId, assignment] of assignments) {
    const next = withoutDeparted(assignment, registeredNodeIds, retainedNodeIds)
    if (next === null) continue
    changed ??= new Map(assignments)
    changed.set(partitionId, next)
  }
  return changed
}
