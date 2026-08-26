import { compareCodePoints } from '../../../core/ordering'
import { capacityShares, rebalanceLeadership } from './leadership'
import type {
  AllocationConstraints,
  AllocationResult,
  AllocationTable,
  Decider,
  DeciderContext,
  NodeRegistration,
  NodeWeight,
  PartitionAssignment,
} from './types'
import { REBALANCE_THRESHOLD } from './types'
import { computeNodeWeights, countNodeAssignments, countPrimaryAssignments, findBestNode } from './weight'

function cloneAssignments(assignments: Map<number, PartitionAssignment>): Map<number, PartitionAssignment> {
  const cloned = new Map<number, PartitionAssignment>()
  for (const [partitionId, assignment] of assignments) {
    cloned.set(partitionId, {
      primary: assignment.primary,
      replicas: [...assignment.replicas],
      inSyncSet: [...assignment.inSyncSet],
      commitPoint: assignment.commitPoint,
      state: assignment.state,
      primaryTerm: assignment.primaryTerm,
    })
  }
  return cloned
}

function markUnassigned(assignment: PartitionAssignment, lastPrimary: string | null, lastInSyncSet: string[]): void {
  const lastHolders = new Set<string>(lastInSyncSet)
  if (lastPrimary !== null) {
    lastHolders.add(lastPrimary)
  }
  assignment.primary = null
  assignment.replicas = []
  assignment.inSyncSet = [...lastHolders].sort(compareCodePoints)
  assignment.state = 'UNASSIGNED'
}

function primaryLoadOf(nodeId: string, primaryCounts: Map<string, number>, shares: Map<string, number>): number {
  const share = shares.get(nodeId)
  return (primaryCounts.get(nodeId) ?? 0) / (share === undefined || share <= 0 ? 1 : share)
}

function leastLoadedCandidate(
  candidates: string[],
  primaryCounts: Map<string, number>,
  shares: Map<string, number>,
): string | undefined {
  let best: string | undefined
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate
      continue
    }
    const bestLoad = primaryLoadOf(best, primaryCounts, shares)
    const candidateLoad = primaryLoadOf(candidate, primaryCounts, shares)
    if (candidateLoad < bestLoad || (candidateLoad === bestLoad && candidate < best)) {
      best = candidate
    }
  }
  return best
}

function handleLostNodes(
  assignments: Map<number, PartitionAssignment>,
  activeNodeIds: Set<string>,
  shares: Map<string, number>,
): void {
  const primaryCounts = countPrimaryAssignments(assignments)

  for (const assignment of assignments.values()) {
    if (assignment.state === 'UNASSIGNED') {
      continue
    }

    const lastPrimary = assignment.primary
    const lastInSyncSet = [...assignment.inSyncSet]
    const primaryWasLost = lastPrimary !== null && !activeNodeIds.has(lastPrimary)

    if (primaryWasLost) {
      assignment.primary = null
    }

    assignment.replicas = assignment.replicas.filter(id => activeNodeIds.has(id))
    assignment.inSyncSet = assignment.inSyncSet.filter(id => activeNodeIds.has(id))

    if (!primaryWasLost) {
      if (assignment.primary === null) {
        markUnassigned(assignment, lastPrimary, lastInSyncSet)
      }
      continue
    }

    const inSyncCandidates = assignment.replicas.filter(id => assignment.inSyncSet.includes(id))

    if (inSyncCandidates.length === 0) {
      markUnassigned(assignment, lastPrimary, lastInSyncSet)
      continue
    }

    const promoted = leastLoadedCandidate(inSyncCandidates, primaryCounts, shares)

    if (promoted === undefined) {
      markUnassigned(assignment, lastPrimary, lastInSyncSet)
      continue
    }

    primaryCounts.set(promoted, (primaryCounts.get(promoted) ?? 0) + 1)
    assignment.primary = promoted
    assignment.replicas = assignment.replicas.filter(id => id !== promoted)
    assignment.inSyncSet = assignment.inSyncSet.filter(id => id !== promoted)
    assignment.primaryTerm += 1
  }
}

function fillReplicaSlots(
  assignments: Map<number, PartitionAssignment>,
  sortedNodes: NodeRegistration[],
  nodeMap: Map<string, NodeRegistration>,
  replicationFactor: number,
  constraints: AllocationConstraints,
  deciders: Decider[],
): void {
  const candidateNodeIds = sortedNodes.map(n => n.nodeId)

  for (const [partitionId, assignment] of assignments) {
    if (assignment.primary === null) {
      continue
    }

    while (assignment.replicas.length < replicationFactor) {
      const nodeAssignmentCounts = countNodeAssignments(assignments)
      const weights = computeNodeWeights(sortedNodes, assignments)

      const replicaContext: Omit<DeciderContext, 'candidateNodeId'> = {
        partitionId,
        role: 'replica',
        currentAssignment: assignment,
        allAssignments: assignments,
        nodeAssignmentCounts,
        nodes: nodeMap,
        constraints,
      }

      const replicaNodeId = findBestNode(candidateNodeIds, weights, deciders, replicaContext)

      if (replicaNodeId === null) {
        break
      }

      assignment.replicas.push(replicaNodeId)
    }
  }
}

function slotWeightOf(nodeId: string, shares: Map<string, number>): number {
  const share = shares.get(nodeId)
  return 1 / (share === undefined || share <= 0 ? 1 : share)
}

/**
 * Reports whether moving one replica off the busiest node and onto the quietest one would leave the two closer in
 * load than they are now.
 *
 * The rebalancer asks this before every move, because a move between two nodes of unequal capacity can widen the very
 * gap it was meant to close; a run that kept making such moves would never settle.
 *
 * @param mostLoaded - The node carrying the heaviest weight.
 * @param leastLoaded - The node carrying the lightest weight.
 * @param shares - Each node's capacity as a multiple of the cluster average, by node id.
 * @returns `true` where the move would narrow the gap, and `false` where it would leave the gap the same or wider.
 */
export function moveNarrowsGap(mostLoaded: NodeWeight, leastLoaded: NodeWeight, shares: Map<string, number>): boolean {
  const gap = mostLoaded.weight - leastLoaded.weight
  const afterMove = Math.abs(gap - slotWeightOf(mostLoaded.nodeId, shares) - slotWeightOf(leastLoaded.nodeId, shares))
  return afterMove < gap
}

function rebalanceForBalance(
  assignments: Map<number, PartitionAssignment>,
  sortedNodes: NodeRegistration[],
  nodeMap: Map<string, NodeRegistration>,
  constraints: AllocationConstraints,
  deciders: Decider[],
  shares: Map<string, number>,
): void {
  let totalSlots = 0
  for (const assignment of assignments.values()) {
    if (assignment.primary !== null) totalSlots++
    totalSlots += assignment.replicas.length
  }

  const maxIterations = totalSlots * 2

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const weights = computeNodeWeights(sortedNodes, assignments)

    if (weights.length < 2) break

    const sorted = [...weights].sort((a, b) => a.weight - b.weight)
    const leastLoaded = sorted[0]
    const mostLoaded = sorted[sorted.length - 1]

    if (mostLoaded.weight - leastLoaded.weight < REBALANCE_THRESHOLD) {
      break
    }

    if (!moveNarrowsGap(mostLoaded, leastLoaded, shares)) {
      break
    }

    const move: ReplicaMove = {
      fromNodeId: mostLoaded.nodeId,
      toNodeId: leastLoaded.nodeId,
      weights,
      nodeMap,
      constraints,
      deciders,
    }

    const laggingFirst = moveOneReplica(assignments, move, true)
    const moved = laggingFirst || moveOneReplica(assignments, move, false)

    if (!moved) break
  }
}

interface ReplicaMove {
  fromNodeId: string
  toNodeId: string
  weights: NodeWeight[]
  nodeMap: Map<string, NodeRegistration>
  constraints: AllocationConstraints
  deciders: Decider[]
}

function moveOneReplica(
  assignments: Map<number, PartitionAssignment>,
  move: ReplicaMove,
  laggingOnly: boolean,
): boolean {
  for (const [partitionId, assignment] of assignments) {
    const replicaIndex = assignment.replicas.indexOf(move.fromNodeId)
    if (replicaIndex < 0) {
      continue
    }
    if (laggingOnly && assignment.inSyncSet.includes(move.fromNodeId)) {
      continue
    }

    const removedReplica = assignment.replicas[replicaIndex]
    assignment.replicas.splice(replicaIndex, 1)

    const moveContext: Omit<DeciderContext, 'candidateNodeId'> = {
      partitionId,
      role: 'replica',
      currentAssignment: assignment,
      allAssignments: assignments,
      nodeAssignmentCounts: countNodeAssignments(assignments),
      nodes: move.nodeMap,
      constraints: move.constraints,
    }

    const target = findBestNode([move.toNodeId], move.weights, move.deciders, moveContext)
    if (target === null) {
      assignment.replicas.splice(replicaIndex, 0, removedReplica)
      continue
    }

    assignment.replicas.push(target)
    return true
  }

  return false
}

function pruneInSyncSets(assignments: Map<number, PartitionAssignment>): void {
  for (const assignment of assignments.values()) {
    if (assignment.state === 'UNASSIGNED') {
      continue
    }
    const stale = assignment.inSyncSet.some(nodeId => !assignment.replicas.includes(nodeId))
    if (stale) {
      assignment.inSyncSet = assignment.inSyncSet.filter(nodeId => assignment.replicas.includes(nodeId))
    }
  }
}

/**
 * Rewrites an existing allocation table for the nodes registered with the cluster today, and reports every partition
 * it had to leave short of replicas.
 *
 * The allocator promotes an in-sync replica wherever it finds a lost primary, refills the empty replica slots, evens
 * the load out across the nodes, and spreads leadership away from the busiest ones. A partition whose primary fails
 * while no in-sync replica survives moves to `UNASSIGNED`, and its `inSyncSet` then records the nodes that last held
 * the data, so that the controller can recognise one of them when it registers again.
 *
 * @param nodes - The data nodes registered with the cluster coordinator.
 * @param currentTable - The allocation table the coordinator holds today.
 * @param constraints - The placement rules that every assignment must satisfy.
 * @param deciders - The chain that admits or refuses each candidate node.
 * @returns The new table, whose version is one above the current one, alongside a warning for each partition holding
 * fewer replicas than the index asked for.
 */
export function rebalanceAllocate(
  nodes: NodeRegistration[],
  currentTable: AllocationTable,
  constraints: AllocationConstraints,
  deciders: Decider[],
): AllocationResult {
  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.nodeId < b.nodeId) return -1
    if (a.nodeId > b.nodeId) return 1
    return 0
  })

  const activeNodeIds = new Set<string>(sortedNodes.map(n => n.nodeId))

  const nodeMap = new Map<string, NodeRegistration>()
  for (const node of sortedNodes) {
    nodeMap.set(node.nodeId, node)
  }

  const assignments = cloneAssignments(currentTable.assignments)
  const shares = capacityShares(sortedNodes)

  handleLostNodes(assignments, activeNodeIds, shares)

  fillReplicaSlots(assignments, sortedNodes, nodeMap, currentTable.replicationFactor, constraints, deciders)

  rebalanceForBalance(assignments, sortedNodes, nodeMap, constraints, deciders, shares)

  rebalanceLeadership(assignments, shares)

  pruneInSyncSets(assignments)

  const warnings = collectReplicationWarnings(assignments, currentTable.replicationFactor)

  return {
    table: {
      indexName: currentTable.indexName,
      version: currentTable.version + 1,
      replicationFactor: currentTable.replicationFactor,
      assignments,
    },
    warnings,
  }
}

function collectReplicationWarnings(
  assignments: Map<number, PartitionAssignment>,
  replicationFactor: number,
): string[] {
  const warnings: string[] = []
  for (const [partitionId, assignment] of assignments) {
    if (assignment.replicas.length < replicationFactor) {
      warnings.push(
        `Partition ${partitionId} has ${assignment.replicas.length} replica(s) instead of requested ${replicationFactor} (insufficient nodes)`,
      )
    }
  }
  return warnings
}
