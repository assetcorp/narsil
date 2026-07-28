import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import type { PartitionAssignment } from '../../coordinator/types'
import { requestInsyncRemoval } from '../../replication/insync'
import { replicateToReplicas } from '../../replication/primary'
import type { ReplicationLogEntry } from '../../replication/types'
import { getInSyncReplicaTargets, resolveNodeTargets } from './assignment'
import type { WriteRoutingDeps } from './types'

export async function assertPrimaryWriteAuthority(entry: ReplicationLogEntry, deps: WriteRoutingDeps): Promise<void> {
  const table = await deps.coordinator.getAllocation(entry.indexName)
  const currentAssignment = table?.assignments.get(entry.partitionId)
  const currentPrimaryNodeId = currentAssignment?.primary ?? null
  const currentPrimaryTerm = currentAssignment?.primaryTerm ?? null

  if (currentPrimaryNodeId === deps.nodeId && currentPrimaryTerm === entry.primaryTerm) {
    return
  }

  throw new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Primary authority changed before acknowledging write for index '${entry.indexName}' partition ${entry.partitionId}`,
    {
      indexName: entry.indexName,
      partitionId: entry.partitionId,
      localNodeId: deps.nodeId,
      expectedPrimaryTerm: entry.primaryTerm,
      currentPrimaryNodeId,
      currentPrimaryTerm,
    },
  )
}

export function appendIndexReplicationEntry(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  documentId: string,
  document: AnyDocument,
  deps: WriteRoutingDeps,
): ReplicationLogEntry {
  const log = deps.getReplicationLog(indexName, partitionId)
  return log.append({
    primaryTerm: assignment.primaryTerm,
    operation: 'INDEX',
    partitionId,
    indexName,
    documentId,
    document: encode(document),
  })
}

export function appendDeleteReplicationEntry(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  documentId: string,
  deps: WriteRoutingDeps,
): ReplicationLogEntry {
  const log = deps.getReplicationLog(indexName, partitionId)
  return log.append({
    primaryTerm: assignment.primaryTerm,
    operation: 'DELETE',
    partitionId,
    indexName,
    documentId,
    document: null,
  })
}

export async function removeFailedReplicasFromInsync(
  entry: ReplicationLogEntry,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
): Promise<void> {
  if (failedReplicas.length === 0) {
    return
  }

  const controllerNodeId = await deps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
      `Failed to remove replicas from in-sync set for index '${entry.indexName}': no active controller lease holder`,
      { indexName: entry.indexName, partitionId: entry.partitionId, failedReplicas },
    )
  }

  for (const replicaNodeId of failedReplicas) {
    const accepted = await requestInsyncRemovalWithTargets(
      entry.indexName,
      entry.partitionId,
      replicaNodeId,
      entry.primaryTerm,
      controllerNodeId,
      deps,
    )

    if (!accepted) {
      throw new NarsilError(
        ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
        `Controller rejected in-sync removal for replica '${replicaNodeId}' of index '${entry.indexName}' partition ${entry.partitionId}`,
        { indexName: entry.indexName, partitionId: entry.partitionId, replicaNodeId },
      )
    }
  }
}

export async function requestInsyncRemovalWithTargets(
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
): Promise<boolean> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  let lastError: unknown

  for (const target of targets) {
    try {
      const result = await requestInsyncRemoval(
        indexName,
        partitionId,
        replicaNodeId,
        primaryTerm,
        target,
        deps.transport,
        deps.nodeId,
      )
      return result.accepted
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function replicateEntry(
  entry: ReplicationLogEntry,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<void> {
  const replicaTargets = getInSyncReplicaTargets(assignment, deps.nodeId)
  const result = await replicateToReplicas(entry, replicaTargets, deps.transport, deps.nodeId, deps.resolveNodeTargets)
  await removeFailedReplicasFromInsync(entry, result.failed, deps)
  await assertPrimaryWriteAuthority(entry, deps)
}
