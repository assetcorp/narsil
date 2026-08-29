import { fnv1a } from '../../../core/hash'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionAssignment } from '../../coordinator/types'
import { routableAllocation } from '../routable-allocation'
import type { PrimaryAssignmentResolution, WriteRoutingDeps } from './types'

export function resolvePartitionId(docId: string, partitionCount: number): number {
  return fnv1a(docId) % partitionCount
}

export async function resolveNodeTargets(nodeId: string, deps: WriteRoutingDeps): Promise<string[]> {
  if (deps.resolveNodeTargets === undefined) {
    return [nodeId]
  }
  const targets = await deps.resolveNodeTargets(nodeId)
  return targets.length > 0 ? targets : [nodeId]
}

export function requireAssignedPrimary(
  assignment: PartitionAssignment | undefined,
  indexName: string,
  partitionId: number,
): PartitionAssignment & { primary: string } {
  if (assignment === undefined || assignment.primary === null) {
    throw new NarsilError(
      ErrorCodes.PARTITION_UNASSIGNED,
      `No primary assigned for partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId },
    )
  }

  return assignment as PartitionAssignment & { primary: string }
}

export async function resolvePrimaryAssignment(
  indexName: string,
  docId: string,
  deps: WriteRoutingDeps,
  requireLocalPrimary: boolean,
): Promise<PrimaryAssignmentResolution | null> {
  const table = await routableAllocation(deps.coordinator, indexName)

  if (table === null) {
    if (requireLocalPrimary) {
      throw new NarsilError(
        ErrorCodes.QUERY_ROUTING_FAILED,
        `No allocation table is available for forwarded write to index '${indexName}'`,
        { indexName },
      )
    }
    return null
  }

  const partitionCount = table.assignments.size
  const partitionId = resolvePartitionId(docId, partitionCount)
  const assignment = requireAssignedPrimary(table.assignments.get(partitionId), indexName, partitionId)

  if (requireLocalPrimary && assignment.primary !== deps.nodeId) {
    throw new NarsilError(
      ErrorCodes.PARTITION_NOT_PRIMARY,
      `Node '${deps.nodeId}' is not primary for partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId, primaryNodeId: assignment.primary, localNodeId: deps.nodeId },
    )
  }

  return { partitionId, assignment }
}

export function assertSufficientActiveReplicas(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): void {
  const requiredActiveCopies = deps.waitForActiveReplicas ?? 1
  if (requiredActiveCopies <= 1) {
    return
  }

  const activeCopies = 1 + getInSyncReplicaTargets(assignment, deps.nodeId).length
  if (activeCopies < requiredActiveCopies) {
    throw new NarsilError(
      ErrorCodes.INSUFFICIENT_REPLICAS,
      `Write to partition ${partitionId} of index '${indexName}' requires ${requiredActiveCopies} active copies but only ${activeCopies} are available`,
      { indexName, partitionId, requiredActiveCopies, activeCopies },
    )
  }
}

export function getInSyncReplicaTargets(
  assignment: PartitionAssignment,
  localNodeId: string,
  pendingAdmissions: string[] = [],
): string[] {
  const configuredReplicas = new Set(assignment.replicas)
  const targets: string[] = []

  for (const nodeId of [...assignment.inSyncSet, ...pendingAdmissions]) {
    if (nodeId !== localNodeId && configuredReplicas.has(nodeId) && !targets.includes(nodeId)) {
      targets.push(nodeId)
    }
  }

  return targets
}
