import type { NodeRegistration, PartitionAssignment } from './types'
import { countPrimaryAssignments } from './weight'

export const LEADERSHIP_IMBALANCE_THRESHOLD = 2

interface LeadershipSwap {
  assignment: PartitionAssignment
  candidateNodeId: string
  candidateLoad: number
}

function loadOf(nodeId: string, counts: Map<string, number>, shares: Map<string, number>): number {
  const share = shares.get(nodeId)
  return (counts.get(nodeId) ?? 0) / (share === undefined || share <= 0 ? 1 : share)
}

function heaviestLeader(shares: Map<string, number>, counts: Map<string, number>): string | undefined {
  let heaviest: string | undefined
  for (const nodeId of shares.keys()) {
    if (heaviest === undefined || loadOf(nodeId, counts, shares) > loadOf(heaviest, counts, shares)) {
      heaviest = nodeId
    }
  }
  return heaviest
}

function findSwap(
  assignments: Map<number, PartitionAssignment>,
  heaviest: string,
  counts: Map<string, number>,
  shares: Map<string, number>,
): LeadershipSwap | null {
  const heaviestLoad = loadOf(heaviest, counts, shares)
  let best: LeadershipSwap | null = null

  for (const assignment of assignments.values()) {
    if (assignment.state !== 'ACTIVE' || assignment.primary !== heaviest) {
      continue
    }
    for (const candidateNodeId of assignment.inSyncSet) {
      const candidateLoad = loadOf(candidateNodeId, counts, shares)
      if (heaviestLoad - candidateLoad < LEADERSHIP_IMBALANCE_THRESHOLD) {
        continue
      }
      if (best === null || candidateLoad < best.candidateLoad) {
        best = { assignment, candidateNodeId, candidateLoad }
      }
    }
  }

  return best
}

function applySwap(swap: LeadershipSwap, previousPrimary: string): void {
  const { assignment, candidateNodeId } = swap
  assignment.primary = candidateNodeId
  assignment.replicas = [...assignment.replicas.filter(nodeId => nodeId !== candidateNodeId), previousPrimary]
  assignment.inSyncSet = assignment.inSyncSet.filter(nodeId => nodeId !== candidateNodeId)
  assignment.primaryTerm += 1
}

export function rebalanceLeadership(assignments: Map<number, PartitionAssignment>, shares: Map<string, number>): void {
  for (let swaps = 0; swaps < assignments.size; swaps++) {
    const counts = countPrimaryAssignments(assignments)
    const heaviest = heaviestLeader(shares, counts)
    if (heaviest === undefined) {
      return
    }

    const swap = findSwap(assignments, heaviest, counts, shares)
    if (swap === null) {
      return
    }

    applySwap(swap, heaviest)
  }
}

export function capacityShares(nodes: NodeRegistration[]): Map<string, number> {
  const shares = new Map<string, number>()
  let totalCapacity = 0
  for (const node of nodes) {
    totalCapacity += node.capacity.memoryBytes
  }
  const averageCapacity = nodes.length > 0 ? totalCapacity / nodes.length : 0
  for (const node of nodes) {
    shares.set(node.nodeId, averageCapacity > 0 ? node.capacity.memoryBytes / averageCapacity : 1)
  }
  return shares
}
