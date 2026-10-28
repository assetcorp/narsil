import type { NodeRegistration, PartitionAssignment } from './types'
import { computeNodeWeights } from './weight'

function weightOf(nodeId: string, weights: Map<string, number>): number {
  return weights.get(nodeId) ?? Number.POSITIVE_INFINITY
}

function surplusCandidate(assignment: PartitionAssignment, weights: Map<string, number>): number {
  let chosen = -1
  for (let index = 0; index < assignment.replicas.length; index++) {
    if (chosen < 0) {
      chosen = index
      continue
    }
    const candidate = assignment.replicas[index]
    const current = assignment.replicas[chosen]
    if (candidate === undefined || current === undefined) continue
    const candidateLags = !assignment.inSyncSet.includes(candidate)
    const currentLags = !assignment.inSyncSet.includes(current)
    if (candidateLags !== currentLags) {
      if (candidateLags) chosen = index
      continue
    }
    const candidateWeight = weightOf(candidate, weights)
    const currentWeight = weightOf(current, weights)
    if (candidateWeight > currentWeight || (candidateWeight === currentWeight && candidate > current)) {
      chosen = index
    }
  }
  return chosen
}

export function trimSurplusReplicas(
  assignments: Map<number, PartitionAssignment>,
  sortedNodes: NodeRegistration[],
  replicationFactor: number,
): void {
  for (const assignment of assignments.values()) {
    while (assignment.replicas.length > replicationFactor) {
      const weights = new Map(computeNodeWeights(sortedNodes, assignments).map(entry => [entry.nodeId, entry.weight]))
      const index = surplusCandidate(assignment, weights)
      if (index < 0) break
      const [removed] = assignment.replicas.splice(index, 1)
      assignment.inSyncSet = assignment.inSyncSet.filter(nodeId => nodeId !== removed)
    }
  }
}
