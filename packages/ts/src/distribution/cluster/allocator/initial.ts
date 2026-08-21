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

/**
 * Spreads an index's partitions over the nodes that may hold them, for an index that has no allocation yet.
 *
 * The allocator picks a primary for each partition and then fills its replica slots, weighing each candidate by how
 * many partitions it already holds and passing every candidate through the deciders, which is how zone awareness and a
 * per-node shard cap take effect. Every partition starts in `INITIALISING` at term 1 with an empty in-sync set and
 * a commit point of zero, because no write has reached it yet.
 *
 * @param nodes - The nodes that may hold a partition of this index.
 * @param indexName - The index being allocated.
 * @param partitionCount - How many partitions the index has.
 * @param replicationFactor - How many replicas each partition takes, over and above its primary.
 * @param constraints - The placement constraints, which cover zone awareness and the per-node shard cap.
 * @param deciders - The rules a candidate node must pass before it may take a partition.
 * @returns The allocation result, which holds the table and the decisions the allocator made.
 * @throws A `NarsilError` with `ALLOCATION_FAILED` when no eligible node can take a partition's primary.
 */
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
      commitPoint: 0,
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
