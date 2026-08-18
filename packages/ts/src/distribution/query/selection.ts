import { compareCodePoints } from '../../core/ordering'
import type { AllocationTable, PartitionAssignment } from '../coordinator/types'

export type ReplicaSelector = (candidates: string[], partitionId: number) => string

export function randomSelector(candidates: string[], _partitionId: number): string {
  return candidates[Math.floor(Math.random() * candidates.length)]
}

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
    if (!assignment.inSyncSet.includes(replica)) {
      continue
    }
    if (!candidates.includes(replica)) {
      candidates.push(replica)
    }
  }

  candidates.sort(compareCodePoints)
  return candidates
}

/**
 * Builds a selector that reads a partition from this node wherever this node
 * holds an eligible copy, and defers to `fallback` otherwise.
 *
 * A local read saves a network hop, and it also sends every partition this
 * node holds to this node whatever its load, so the default stays
 * {@link randomSelector} and a caller asks for locality by name.
 *
 * @param localNodeId - The node doing the reading.
 * @param fallback - Picks the copy where this node holds none.
 * @returns The selector to pass to {@link selectReplica}.
 */
export function preferLocalSelector(localNodeId: string, fallback: ReplicaSelector = randomSelector): ReplicaSelector {
  return (candidates: string[], partitionId: number): string =>
    candidates.includes(localNodeId) ? localNodeId : fallback(candidates, partitionId)
}

export function selectReplica(
  assignment: PartitionAssignment,
  selector: ReplicaSelector = randomSelector,
  partitionId: number = 0,
): string | null {
  const candidates = collectActiveCandidates(assignment)

  if (candidates.length === 0) {
    return null
  }

  return selector(candidates, partitionId)
}

export interface PartitionRouting {
  nodeToPartitions: Map<string, number[]>
  unavailablePartitions: number[]
}

export function selectReplicasForQuery(
  allocationTable: AllocationTable,
  selector: ReplicaSelector = randomSelector,
): PartitionRouting {
  const nodeToPartitions = new Map<string, number[]>()
  const unavailablePartitions: number[] = []

  for (const [partitionId, assignment] of allocationTable.assignments) {
    const selectedNode = selectReplica(assignment, selector, partitionId)

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
