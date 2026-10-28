import { leastLoadedCandidate } from './lost-nodes'
import type { AllocationConstraints, Decider, DeciderContext, NodeRegistration, PartitionAssignment } from './types'
import { computeNodeWeights, countNodeAssignments, countPrimaryAssignments, findBestNode } from './weight'

export interface PlacementContext {
  placementNodes: NodeRegistration[]
  nodeMap: Map<string, NodeRegistration>
  constraints: AllocationConstraints
  deciders: Decider[]
  drainingNodeIds: ReadonlySet<string>
}

export function replicasOutsideMove(assignment: PartitionAssignment): string[] {
  const removing = assignment.removingReplicas
  return removing === undefined ? assignment.replicas : assignment.replicas.filter(id => !removing.includes(id))
}

export function placeReplica(
  assignments: Map<number, PartitionAssignment>,
  partitionId: number,
  assignment: PartitionAssignment,
  context: PlacementContext,
): string | null {
  const replicaContext: Omit<DeciderContext, 'candidateNodeId'> = {
    partitionId,
    role: 'replica',
    currentAssignment: assignment,
    allAssignments: assignments,
    nodeAssignmentCounts: countNodeAssignments(assignments),
    nodes: context.nodeMap,
    constraints: context.constraints,
  }
  return findBestNode(
    context.placementNodes.map(node => node.nodeId),
    computeNodeWeights(context.placementNodes, assignments),
    context.deciders,
    replicaContext,
  )
}

export function settleMoves(assignments: Map<number, PartitionAssignment>, replicationFactor: number): void {
  for (const assignment of assignments.values()) {
    const removing = assignment.removingReplicas?.filter(id => assignment.replicas.includes(id))
    if (removing === undefined) continue
    delete assignment.removingReplicas
    if (removing.length === 0) continue
    const outside = assignment.replicas.filter(id => !removing.includes(id))
    const inSyncOutside = outside.filter(id => assignment.inSyncSet.includes(id))
    if (inSyncOutside.length >= replicationFactor) {
      assignment.replicas = outside
      assignment.inSyncSet = assignment.inSyncSet.filter(id => !removing.includes(id))
      continue
    }
    if (outside.length >= replicationFactor) {
      assignment.removingReplicas = removing
    }
  }
}

function seedSuccessor(
  assignments: Map<number, PartitionAssignment>,
  partitionId: number,
  assignment: PartitionAssignment,
  context: PlacementContext,
): void {
  if (assignment.removingReplicas !== undefined) return
  if (assignment.replicas.some(id => !context.drainingNodeIds.has(id))) return
  const target = placeReplica(assignments, partitionId, assignment, context)
  if (target !== null) assignment.replicas.push(target)
}

export function handOverDrainingLeads(
  assignments: Map<number, PartitionAssignment>,
  context: PlacementContext,
  shares: Map<string, number>,
): void {
  const primaryCounts = countPrimaryAssignments(assignments)
  for (const [partitionId, assignment] of assignments) {
    const leader = assignment.primary
    if (assignment.state !== 'ACTIVE' || leader === null || !context.drainingNodeIds.has(leader)) continue
    const staying = replicasOutsideMove(assignment).filter(
      id => assignment.inSyncSet.includes(id) && !context.drainingNodeIds.has(id),
    )
    const successor = leastLoadedCandidate(staying, primaryCounts, shares)
    if (successor === undefined) {
      seedSuccessor(assignments, partitionId, assignment, context)
      continue
    }
    primaryCounts.set(successor, (primaryCounts.get(successor) ?? 0) + 1)
    primaryCounts.set(leader, (primaryCounts.get(leader) ?? 1) - 1)
    assignment.primary = successor
    assignment.replicas = [...assignment.replicas.filter(id => id !== successor), leader]
    assignment.inSyncSet = [...assignment.inSyncSet.filter(id => id !== successor && id !== leader), leader]
    assignment.primaryTerm += 1
  }
}

export function moveDrainingReplicas(
  assignments: Map<number, PartitionAssignment>,
  context: PlacementContext,
  replicationFactor: number,
): void {
  for (const [partitionId, assignment] of assignments) {
    if (assignment.state !== 'ACTIVE' || assignment.removingReplicas !== undefined) continue
    if (assignment.primary === null || context.drainingNodeIds.has(assignment.primary)) continue
    const source = assignment.replicas.find(id => context.drainingNodeIds.has(id))
    if (source === undefined) continue
    const staying = assignment.replicas.filter(
      id => id !== source && assignment.inSyncSet.includes(id) && !context.drainingNodeIds.has(id),
    )
    if (staying.length < replicationFactor) {
      const target = placeReplica(assignments, partitionId, assignment, context)
      if (target === null) continue
      assignment.replicas.push(target)
    }
    assignment.removingReplicas = [source]
  }
}
