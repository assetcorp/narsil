import type { AllocationTable, PartitionAssignment } from '../coordinator/types'

export type ReplicaSelector = (candidates: string[], partitionId: number) => string

export function hashBasedSelector(candidates: string[], partitionId: number): string {
  return candidates[partitionId % candidates.length]
}

export function collectActiveCandidates(assignment: PartitionAssignment): string[] {
  if (assignment.state !== 'ACTIVE') {
    return []
  }

  const candidates: string[] = []

  if (assignment.primary !== null) {
    candidates.push(assignment.primary)
  }

  for (const replica of assignment.replicas) {
    if (!candidates.includes(replica)) {
      candidates.push(replica)
    }
  }

  candidates.sort()
  return candidates
}

export function selectReplica(
  assignment: PartitionAssignment,
  localNodeId: string | null,
  selector: ReplicaSelector = hashBasedSelector,
  partitionId: number = 0,
): string | null {
  const candidates = collectActiveCandidates(assignment)

  if (candidates.length === 0) {
    return null
  }

  if (localNodeId !== null && candidates.includes(localNodeId)) {
    return localNodeId
  }

  return selector(candidates, partitionId)
}

export interface PartitionRouting {
  nodeToPartitions: Map<string, number[]>
  unavailablePartitions: number[]
}

export function selectReplicasForQuery(
  allocationTable: AllocationTable,
  localNodeId: string | null,
  selector: ReplicaSelector = hashBasedSelector,
): PartitionRouting {
  const nodeToPartitions = new Map<string, number[]>()
  const unavailablePartitions: number[] = []

  for (const [partitionId, assignment] of allocationTable.assignments) {
    const selectedNode = selectReplica(assignment, localNodeId, selector, partitionId)

    if (selectedNode === null) {
      unavailablePartitions.push(partitionId)
      continue
    }

    let partitions = nodeToPartitions.get(selectedNode)
    if (partitions === undefined) {
      partitions = []
      nodeToPartitions.set(selectedNode, partitions)
    }
    partitions.push(partitionId)
  }

  return { nodeToPartitions, unavailablePartitions }
}
