import type { Decider, DeciderContext, NodeRegistration, NodeWeight, PartitionAssignment } from './types'

/**
 * Counts how many partition copies each node carries, whether it holds them as primary or as replica.
 *
 * The allocator reads these counts when it decides where a new copy may go, because a node already carrying many
 * copies is the one it moves work away from.
 *
 * @param assignments - The assignments to count, by partition id.
 * @returns The number of copies each node carries, by node id, which omits a node carrying none.
 */
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

/**
 * Counts how many partitions each node leads as primary.
 *
 * A primary takes every write for its partitions and answers the reads that ask for the newest data, so the
 * allocator balances these counts separately from the total copy counts.
 *
 * @param assignments - The assignments to count, by partition id.
 * @returns The number of partitions each node leads, by node id, which omits a node leading none.
 */
export function countPrimaryAssignments(assignments: Map<number, PartitionAssignment>): Map<string, number> {
  const counts = new Map<string, number>()

  for (const assignment of assignments.values()) {
    if (assignment.primary !== null) {
      counts.set(assignment.primary, (counts.get(assignment.primary) ?? 0) + 1)
    }
  }

  return counts
}

/**
 * Weighs every node by how much of the index it already carries against how much memory it has.
 *
 * The allocator sorts candidates by these weights, so a node of twice the average memory may carry twice the copies
 * before it weighs the same as its neighbours. Each entry carries the raw counts alongside the weights, and the
 * result comes back sorted by node id, so that two runs over the same cluster place the copies the same way.
 *
 * @param nodes - The data nodes registered with the cluster coordinator.
 * @param assignments - The assignments the weights are measured against, by partition id.
 * @returns One entry for each node, sorted by node id.
 */
export function computeNodeWeights(
  nodes: NodeRegistration[],
  assignments: Map<number, PartitionAssignment>,
): NodeWeight[] {
  const assignmentCounts = countNodeAssignments(assignments)
  const primaryCounts = countPrimaryAssignments(assignments)

  let totalCapacity = 0
  for (const node of nodes) {
    totalCapacity += node.capacity.memoryBytes
  }

  const averageCapacity = nodes.length > 0 ? totalCapacity / nodes.length : 0

  const weights: NodeWeight[] = []

  for (const node of nodes) {
    const partitionCount = assignmentCounts.get(node.nodeId) ?? 0
    const primaryCount = primaryCounts.get(node.nodeId) ?? 0
    const normalizedCapacity = averageCapacity > 0 ? node.capacity.memoryBytes / averageCapacity : 1

    weights.push({
      nodeId: node.nodeId,
      weight: partitionCount / normalizedCapacity,
      partitionCount,
      primaryWeight: primaryCount / normalizedCapacity,
      primaryCount,
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

/**
 * Picks the least loaded node that the placement rules admit, and reports `null` where they admit none.
 *
 * The function sorts the candidates by weight, lightest first, and it walks that order until one candidate satisfies
 * every decider. A candidate that a decider throttles is held back and returned only where no candidate passes
 * outright, so that a throttled placement beats no placement at all. A primary placement compares the primary
 * weights before the total weights, because leadership is what the caller asked to spread.
 *
 * @param candidates - The node ids that may take the copy.
 * @param weights - The weights that order the candidates.
 * @param deciders - The chain that admits, throttles, or refuses each candidate.
 * @param context - The partition, the role, and the constraints the deciders judge against.
 * @returns The chosen node id, or `null` where every decider refused every candidate.
 */
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
    if (context.role === 'primary') {
      const primaryA = wA?.primaryWeight ?? 0
      const primaryB = wB?.primaryWeight ?? 0
      if (primaryA !== primaryB) return primaryA - primaryB
    }
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
