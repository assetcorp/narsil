import type { Decider, DeciderContext, NodeRegistration, NodeWeight, PartitionAssignment } from './types'

export function countNodeAssignments(assignments: Map<number, PartitionAssignment>): Map<string, number> {
  const counts = new Map<string, number>()

  for (const assignment of assignments.values()) {
    if (assignment.primary !== null) {
      counts.set(assignment.primary, (counts.get(assignment.primary) ?? 0) + 1)
    }
    for (const replica of assignment.replicas) {
      counts.set(replica, (counts.get(replica) ?? 0) + 1)
    }
  }

  return counts
}

export function computeNodeWeights(
  nodes: NodeRegistration[],
  assignments: Map<number, PartitionAssignment>,
): NodeWeight[] {
  const assignmentCounts = countNodeAssignments(assignments)

  let totalCapacity = 0
  for (const node of nodes) {
    totalCapacity += node.capacity.memoryBytes
  }

  const averageCapacity = nodes.length > 0 ? totalCapacity / nodes.length : 0

  const weights: NodeWeight[] = []

  for (const node of nodes) {
    const partitionCount = assignmentCounts.get(node.nodeId) ?? 0
    const normalizedCapacity = averageCapacity > 0 ? node.capacity.memoryBytes / averageCapacity : 1
    const weight = partitionCount / normalizedCapacity

    weights.push({
      nodeId: node.nodeId,
      weight,
      partitionCount,
      capacity: node.capacity.memoryBytes,
    })
  }

  weights.sort((a, b) => {
    if (a.nodeId < b.nodeId) return -1
    if (a.nodeId > b.nodeId) return 1
    return 0
  })

  return weights
}

export function findBestNode(
  candidates: string[],
  weights: NodeWeight[],
  deciders: Decider[],
  context: Omit<DeciderContext, 'candidateNodeId'>,
): string | null {
  const weightByNodeId = new Map<string, NodeWeight>()
  for (const w of weights) {
    weightByNodeId.set(w.nodeId, w)
  }

  const sorted = [...candidates].sort((a, b) => {
    const wA = weightByNodeId.get(a)
    const wB = weightByNodeId.get(b)
    const weightA = wA?.weight ?? 0
    const weightB = wB?.weight ?? 0
    if (weightA !== weightB) return weightA - weightB
    if (a < b) return -1
    if (a > b) return 1
    return 0
  })

  let throttledCandidate: string | null = null

  for (const candidateNodeId of sorted) {
    const verdict = runAllDeciders(deciders, { ...context, candidateNodeId })

    if (verdict === 'YES') {
      return candidateNodeId
    }

    if (verdict === 'THROTTLE' && throttledCandidate === null) {
      throttledCandidate = candidateNodeId
    }
  }

  return throttledCandidate
}

function runAllDeciders(deciders: Decider[], context: DeciderContext): 'YES' | 'NO' | 'THROTTLE' {
  let hasThrottle = false

  for (const decider of deciders) {
    const verdict = decider.canAllocate(context)
    if (verdict === 'NO') return 'NO'
    if (verdict === 'THROTTLE') hasThrottle = true
  }

  return hasThrottle ? 'THROTTLE' : 'YES'
}
