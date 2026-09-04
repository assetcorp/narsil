import { LEADERSHIP_IMBALANCE_THRESHOLD } from '../constants'
import type { NodeRegistration, PartitionAssignment } from './types'
import { countPrimaryAssignments } from './weight'

interface LeadershipSwap {
  assignment: PartitionAssignment
  candidateNodeId: string
  candidateLoad: number
}

function loadOf(nodeId: string, counts: Map<string, number>, shares: Map<string, number>): number {
  const share = shares.get(nodeId)
  return (counts.get(nodeId) ?? 0) / (share === undefined || share <= 0 ? 1 : share)
}

function heaviestLeader(
  shares: Map<string, number>,
  counts: Map<string, number>,
  withoutHandover: Set<string>,
): string | undefined {
  let heaviest: string | undefined
  for (const nodeId of shares.keys()) {
    if (withoutHandover.has(nodeId)) {
      continue
    }
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
  assignment.inSyncSet = [
    ...assignment.inSyncSet.filter(nodeId => nodeId !== candidateNodeId && nodeId !== previousPrimary),
    previousPrimary,
  ]
  assignment.primaryTerm += 1
}

/**
 * Hands leadership of some partitions from the busiest nodes to quieter ones, changing the assignments in place.
 *
 * A node that leads many partitions takes every write for them, so the allocator moves leadership until no node
 * leads {@link LEADERSHIP_IMBALANCE_THRESHOLD} partitions more than one of its own in-sync replicas does, measured
 * against each node's share of the cluster's capacity. Each handover names a replica that is already in sync and
 * raises the term. The old primary rejoins both the replica list and the in-sync set, because it holds every write
 * the cluster acknowledged, so a failover straight afterwards may promote it back. The loop stops once it runs out
 * of worthwhile moves, and it never runs longer than the number of partitions. A node whose partitions offer no
 * worthwhile handover drops out of the search, so that the allocator goes on to the next-busiest node in place of
 * abandoning the whole pass.
 *
 * @param assignments - The assignments to rewrite, by partition id.
 * @param shares - Each node's capacity as a multiple of the cluster average, by node id.
 */
export function rebalanceLeadership(assignments: Map<number, PartitionAssignment>, shares: Map<string, number>): void {
  const withoutHandover = new Set<string>()
  for (let swaps = 0; swaps < assignments.size; swaps++) {
    const counts = countPrimaryAssignments(assignments)
    const heaviest = heaviestLeader(shares, counts, withoutHandover)
    if (heaviest === undefined) {
      return
    }

    const swap = findSwap(assignments, heaviest, counts, shares)
    if (swap === null) {
      withoutHandover.add(heaviest)
      continue
    }

    applySwap(swap, heaviest)
  }
}

/**
 * Reports how much of the cluster's memory each node carries, as a multiple of what an average node carries.
 *
 * The allocator divides a node's partition count by this figure before it compares two nodes, so that a node with
 * twice the memory of its neighbours may hold twice as many partitions before the allocator calls it overloaded. A
 * node registered with no memory, and every node where the cluster reports none at all, takes a share of 1.
 *
 * @param nodes - The data nodes registered with the cluster coordinator.
 * @returns Each node's share, by node id, where 1 means a node of average size.
 */
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
