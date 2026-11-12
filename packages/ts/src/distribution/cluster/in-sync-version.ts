import type {
  AllocationTable,
  ClusterCoordinator,
  ExpectedReplicaRegistration,
  PartitionAssignment,
} from '../coordinator/types'

export function inSyncVersionOf(assignment: PartitionAssignment): number {
  return assignment.inSyncVersion ?? 0
}

function holdSameMembers(left: readonly string[], right: readonly string[]): boolean {
  const leftMembers = new Set(left)
  const rightMembers = new Set(right)
  if (leftMembers.size !== rightMembers.size) return false
  for (const nodeId of rightMembers) {
    if (!leftMembers.has(nodeId)) return false
  }
  return true
}

function dropsAReplica(previous: PartitionAssignment, next: PartitionAssignment): boolean {
  const nextReplicas = new Set(next.replicas)
  return previous.replicas.some(nodeId => !nextReplicas.has(nodeId))
}

function stampedInSyncVersion(previous: PartitionAssignment | undefined, next: PartitionAssignment): number {
  if (previous === undefined) return inSyncVersionOf(next)
  const stored = inSyncVersionOf(previous)
  const unchanged = holdSameMembers(previous.inSyncSet, next.inSyncSet) && !dropsAReplica(previous, next)
  const raised = unchanged ? stored : stored + 1
  return Math.max(raised, inSyncVersionOf(next))
}

export function withInSyncVersions(previous: AllocationTable | null, next: AllocationTable): AllocationTable {
  let stamped: Map<number, PartitionAssignment> | null = null
  for (const [partitionId, assignment] of next.assignments) {
    const version = stampedInSyncVersion(previous?.assignments.get(partitionId), assignment)
    if (version === inSyncVersionOf(assignment)) continue
    stamped ??= new Map(next.assignments)
    stamped.set(partitionId, { ...assignment, inSyncVersion: version })
  }
  return stamped === null ? next : { ...next, assignments: stamped }
}

export function putAllocationOver(
  coordinator: ClusterCoordinator,
  indexName: string,
  previous: AllocationTable | null,
  next: AllocationTable,
  writerNodeId: string,
  replicaRegistration?: ExpectedReplicaRegistration,
): Promise<boolean> {
  return coordinator.putAllocation(
    indexName,
    withInSyncVersions(previous, next),
    previous === null ? null : previous.version,
    writerNodeId,
    replicaRegistration,
  )
}
