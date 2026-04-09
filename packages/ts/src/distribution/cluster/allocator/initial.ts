import { ErrorCodes, NarsilError } from '../../../errors'
import type {
  AllocationConstraints,
  AllocationTable,
  Decider,
  DeciderContext,
  NodeRegistration,
  PartitionAssignment,
} from './types'
import { computeNodeWeights, findBestNode } from './weight'

export function initialAllocate(
  nodes: NodeRegistration[],
  indexName: string,
  partitionCount: number,
  replicationFactor: number,
  constraints: AllocationConstraints,
  deciders: Decider[],
): AllocationTable {
  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.nodeId < b.nodeId) return -1
    if (a.nodeId > b.nodeId) return 1
    return 0
  })

  const nodeMap = new Map<string, NodeRegistration>()
  for (const node of sortedNodes) {
    nodeMap.set(node.nodeId, node)
  }

  const nodeAssignmentCounts = new Map<string, number>()
  for (const node of sortedNodes) {
    nodeAssignmentCounts.set(node.nodeId, 0)
  }

  const assignments = new Map<number, PartitionAssignment>()
  const candidateNodeIds = sortedNodes.map(n => n.nodeId)

  for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
    const weights = computeNodeWeights(sortedNodes, assignments)

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

    nodeAssignmentCounts.set(primaryNodeId, (nodeAssignmentCounts.get(primaryNodeId) ?? 0) + 1)

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

      const replicaContext: Omit<DeciderContext, 'candidateNodeId'> = {
        partitionId,
        role: 'replica',
        currentAssignment: partialAssignment,
        allAssignments: assignments,
        nodeAssignmentCounts,
        nodes: nodeMap,
        constraints,
      }

      const replicaNodeId = findBestNode(candidateNodeIds, replicaWeights, deciders, replicaContext)

      if (replicaNodeId === null) {
        break
      }

      replicas.push(replicaNodeId)
      nodeAssignmentCounts.set(replicaNodeId, (nodeAssignmentCounts.get(replicaNodeId) ?? 0) + 1)
    }
  }

  return {
    indexName,
    version: 1,
    replicationFactor,
    assignments,
  }
}
