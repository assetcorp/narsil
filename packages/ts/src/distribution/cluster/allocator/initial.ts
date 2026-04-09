import { ErrorCodes, NarsilError } from '../../../errors'
import type {
  AllocationConstraints,
  AllocationResult,
  Decider,
  DeciderContext,
  NodeRegistration,
  PartitionAssignment,
} from './types'
import { computeNodeWeights, countNodeAssignments, findBestNode } from './weight'

export function initialAllocate(
  nodes: NodeRegistration[],
  indexName: string,
  partitionCount: number,
  replicationFactor: number,
  constraints: AllocationConstraints,
  deciders: Decider[],
): AllocationResult {
  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.nodeId < b.nodeId) return -1
    if (a.nodeId > b.nodeId) return 1
    return 0
  })

  const nodeMap = new Map<string, NodeRegistration>()
  for (const node of sortedNodes) {
    nodeMap.set(node.nodeId, node)
  }

  const assignments = new Map<number, PartitionAssignment>()
  const candidateNodeIds = sortedNodes.map(n => n.nodeId)

  for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
    const weights = computeNodeWeights(sortedNodes, assignments)
    const nodeAssignmentCounts = countNodeAssignments(assignments)

    const primaryContext: Omit<DeciderContext, 'candidateNodeId'> = {
      partitionId,
      role: 'primary',
      currentAssignment: undefined,
      allAssignments: assignments,
      nodeAssignmentCounts,
      nodes: nodeMap,
      constraints,
    }

    const primaryNodeId = findBestNode(candidateNodeIds, weights, deciders, primaryContext)

    if (primaryNodeId === null) {
      throw new NarsilError(ErrorCodes.ALLOCATION_FAILED, `No eligible node for primary of partition ${partitionId}`, {
        partitionId,
        role: 'primary',
      })
    }

    const replicas: string[] = []

    const partialAssignment: PartitionAssignment = {
      primary: primaryNodeId,
      replicas,
      inSyncSet: [],
      state: 'INITIALISING',
      primaryTerm: 1,
    }

    assignments.set(partitionId, partialAssignment)

    for (let replicaSlot = 0; replicaSlot < replicationFactor; replicaSlot++) {
      const replicaWeights = computeNodeWeights(sortedNodes, assignments)
      const replicaCounts = countNodeAssignments(assignments)

      const replicaContext: Omit<DeciderContext, 'candidateNodeId'> = {
        partitionId,
        role: 'replica',
        currentAssignment: partialAssignment,
        allAssignments: assignments,
        nodeAssignmentCounts: replicaCounts,
        nodes: nodeMap,
        constraints,
      }

      const replicaNodeId = findBestNode(candidateNodeIds, replicaWeights, deciders, replicaContext)

      if (replicaNodeId === null) {
        break
      }

      replicas.push(replicaNodeId)
    }
  }

  const warnings: string[] = []
  for (const [partitionId, assignment] of assignments) {
    if (assignment.replicas.length < replicationFactor) {
      warnings.push(
        `Partition ${partitionId} has ${assignment.replicas.length} replica(s) instead of requested ${replicationFactor} (insufficient nodes)`,
      )
    }
  }

  return {
    table: {
      indexName,
      version: 1,
      replicationFactor,
      assignments,
    },
    warnings,
  }
}
