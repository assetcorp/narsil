import type {
  AllocationConstraints,
  AllocationTable,
  Decider,
  DeciderContext,
  NodeRegistration,
  PartitionAssignment,
} from './types'
import { REBALANCE_THRESHOLD } from './types'
import { computeNodeWeights, countNodeAssignments, findBestNode } from './weight'

function cloneAssignments(assignments: Map<number, PartitionAssignment>): Map<number, PartitionAssignment> {
  const cloned = new Map<number, PartitionAssignment>()
  for (const [partitionId, assignment] of assignments) {
    cloned.set(partitionId, {
      primary: assignment.primary,
      replicas: [...assignment.replicas],
      inSyncSet: [...assignment.inSyncSet],
      state: assignment.state,
      primaryTerm: assignment.primaryTerm,
    })
  }
  return cloned
}

function handleLostNodes(assignments: Map<number, PartitionAssignment>, activeNodeIds: Set<string>): void {
  for (const assignment of assignments.values()) {
    if (assignment.primary !== null && !activeNodeIds.has(assignment.primary)) {
      assignment.primary = null
    }

    assignment.replicas = assignment.replicas.filter(id => activeNodeIds.has(id))
    assignment.inSyncSet = assignment.inSyncSet.filter(id => activeNodeIds.has(id))

    if (assignment.primary === null && assignment.replicas.length > 0) {
      assignment.primary = assignment.replicas[0]
      assignment.replicas = assignment.replicas.slice(1)
    }

    if (assignment.primary === null && assignment.replicas.length === 0) {
      assignment.state = 'UNASSIGNED'
    }
  }
}

function fillUnassignedSlots(
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
      const nodeAssignmentCounts = countNodeAssignments(assignments)
      const weights = computeNodeWeights(sortedNodes, assignments)

      const primaryContext: Omit<DeciderContext, 'candidateNodeId'> = {
        partitionId,
        role: 'primary',
        currentAssignment: assignment,
        allAssignments: assignments,
        nodeAssignmentCounts,
        nodes: nodeMap,
        constraints,
      }

      const primaryNodeId = findBestNode(candidateNodeIds, weights, deciders, primaryContext)

      if (primaryNodeId !== null) {
        assignment.primary = primaryNodeId
        assignment.state = 'INITIALISING'
      }
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

function rebalanceForBalance(
  assignments: Map<number, PartitionAssignment>,
  sortedNodes: NodeRegistration[],
  nodeMap: Map<string, NodeRegistration>,
  constraints: AllocationConstraints,
  deciders: Decider[],
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

    let moved = false

    for (const [partitionId, assignment] of assignments) {
      if (moved) break

      if (assignment.primary === mostLoaded.nodeId) {
        const nodeAssignmentCounts = countNodeAssignments(assignments)
        const moveContext: Omit<DeciderContext, 'candidateNodeId'> = {
          partitionId,
          role: 'primary',
          currentAssignment: assignment,
          allAssignments: assignments,
          nodeAssignmentCounts,
          nodes: nodeMap,
          constraints,
        }

        const target = findBestNode([leastLoaded.nodeId], weights, deciders, moveContext)
        if (target !== null) {
          assignment.primary = target
          moved = true
          continue
        }
      }

      const replicaIndex = assignment.replicas.indexOf(mostLoaded.nodeId)
      if (replicaIndex >= 0) {
        const tempReplicas = assignment.replicas.filter((_, i) => i !== replicaIndex)
        const tempAssignment: PartitionAssignment = { ...assignment, replicas: tempReplicas }

        const nodeAssignmentCounts = countNodeAssignments(assignments)
        nodeAssignmentCounts.set(mostLoaded.nodeId, (nodeAssignmentCounts.get(mostLoaded.nodeId) ?? 1) - 1)

        const moveContext: Omit<DeciderContext, 'candidateNodeId'> = {
          partitionId,
          role: 'replica',
          currentAssignment: tempAssignment,
          allAssignments: assignments,
          nodeAssignmentCounts,
          nodes: nodeMap,
          constraints,
        }

        const target = findBestNode([leastLoaded.nodeId], weights, deciders, moveContext)
        if (target !== null) {
          assignment.replicas[replicaIndex] = target
          moved = true
        }
      }
    }

    if (!moved) break
  }
}

export function rebalanceAllocate(
  nodes: NodeRegistration[],
  currentTable: AllocationTable,
  constraints: AllocationConstraints,
  deciders: Decider[],
): AllocationTable {
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

  handleLostNodes(assignments, activeNodeIds)

  fillUnassignedSlots(assignments, sortedNodes, nodeMap, currentTable.replicationFactor, constraints, deciders)

  rebalanceForBalance(assignments, sortedNodes, nodeMap, constraints, deciders)

  return {
    indexName: currentTable.indexName,
    version: currentTable.version + 1,
    replicationFactor: currentTable.replicationFactor,
    assignments,
  }
}
