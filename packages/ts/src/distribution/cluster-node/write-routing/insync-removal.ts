import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import { requestInsyncRemoval } from '../../replication/insync'
import type { ReplicationLogEntry } from '../../replication/types'
import { recordRemovalUnlessReadmitted } from '../catch-up/admitted'
import { admissionGenerationOf } from '../catch-up/state'
import { sendThroughTargets } from '../transport-failure'
import { resolveNodeTargets } from './assignment'
import { replicationTimeoutOf, withinDeadline } from './deadline'
import type { WriteRoutingDeps } from './types'

export type TermScope = Pick<ReplicationLogEntry, 'indexName' | 'partitionId' | 'primaryTerm'>

function termLost(error: unknown): error is NarsilError {
  return error instanceof NarsilError && error.code === ErrorCodes.PARTITION_NOT_PRIMARY
}

export async function assertPrimaryWriteAuthority(entry: TermScope, deps: WriteRoutingDeps): Promise<void> {
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

async function confirmTermHeld(entry: TermScope, deps: WriteRoutingDeps): Promise<void> {
  await deps.refreshAllocation?.(entry.indexName)
  await assertPrimaryWriteAuthority(entry, deps)
}

async function movedTermOf(entry: TermScope, deps: WriteRoutingDeps): Promise<NarsilError | undefined> {
  const timeoutMs = replicationTimeoutOf(deps)
  try {
    await withinDeadline(
      confirmTermHeld(entry, deps),
      timeoutMs,
      () => new Error(`Reading the allocation of index '${entry.indexName}' did not finish within ${timeoutMs}ms`),
    )
    return undefined
  } catch (error) {
    return termLost(error) ? error : undefined
  }
}

async function removalFailure(
  entry: TermScope,
  failedReplicas: string[],
  error: unknown,
  deps: WriteRoutingDeps,
): Promise<NarsilError> {
  const moved = await movedTermOf(entry, deps)
  if (moved !== undefined) return moved
  if (error instanceof NarsilError && error.code === ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED) return error
  return new NarsilError(
    ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
    `Removing failed replicas from the in-sync set of index '${entry.indexName}' partition ${entry.partitionId} failed: ${describeError(error)}`,
    {
      indexName: entry.indexName,
      partitionId: entry.partitionId,
      failedReplicas,
      ...(error instanceof NarsilError ? { causeCode: error.code } : {}),
    },
  )
}

async function removeWithinTimeout(entry: TermScope, failedReplicas: string[], deps: WriteRoutingDeps): Promise<void> {
  const timeoutMs = replicationTimeoutOf(deps)
  let open = true
  try {
    await withinDeadline(
      removeEachFailedReplica(entry, failedReplicas, deps, () => open),
      timeoutMs,
      () =>
        new NarsilError(
          ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
          `Removing failed replicas from the in-sync set of index '${entry.indexName}' partition ${entry.partitionId} did not finish within ${timeoutMs}ms`,
          { indexName: entry.indexName, partitionId: entry.partitionId, failedReplicas, timeoutMs },
        ),
    )
  } finally {
    open = false
  }
}

export async function removeFailedReplicasFromInsync(
  entry: TermScope,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
): Promise<void> {
  if (failedReplicas.length === 0) {
    return
  }
  try {
    await removeWithinTimeout(entry, failedReplicas, deps)
  } catch (error) {
    if (termLost(error)) throw error
    throw await removalFailure(entry, failedReplicas, error, deps)
  }
}

async function removeEachFailedReplica(
  entry: TermScope,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
  live: () => boolean,
): Promise<void> {
  const controllerNodeId = await controllerForRemoval(entry, failedReplicas, deps)
  for (const replicaNodeId of failedReplicas) {
    if (!live()) return
    const generationAtRemoval = admissionGenerationOf(deps.catchUp, entry.indexName, entry.partitionId, replicaNodeId)
    await removeReplicaFromInsync(entry, replicaNodeId, controllerNodeId, generationAtRemoval, deps, live)
  }
}

export async function controllerForRemoval(
  entry: TermScope,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
): Promise<string> {
  const controllerNodeId = await deps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId !== null) return controllerNodeId
  await deps.refreshAllocation?.(entry.indexName)
  await assertPrimaryWriteAuthority(entry, deps)
  throw new NarsilError(
    ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
    `Failed to remove replicas from in-sync set for index '${entry.indexName}': no active controller lease holder`,
    { indexName: entry.indexName, partitionId: entry.partitionId, failedReplicas },
  )
}

export async function removeReplicaFromInsync(
  entry: TermScope,
  replicaNodeId: string,
  controllerNodeId: string,
  generationAtRemoval: number,
  deps: WriteRoutingDeps,
  stillWanted?: () => boolean,
): Promise<void> {
  const accepted = await requestInsyncRemovalWithTargets(
    entry.indexName,
    entry.partitionId,
    replicaNodeId,
    entry.primaryTerm,
    controllerNodeId,
    deps,
    stillWanted,
  )
  if (!accepted) {
    await deps.refreshAllocation?.(entry.indexName)
    await assertPrimaryWriteAuthority(entry, deps)
    throw new NarsilError(
      ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
      `Controller rejected in-sync removal for replica '${replicaNodeId}' of index '${entry.indexName}' partition ${entry.partitionId}`,
      { indexName: entry.indexName, partitionId: entry.partitionId, replicaNodeId },
    )
  }
  recordRemovalUnlessReadmitted(
    deps.catchUp,
    entry.indexName,
    entry.partitionId,
    replicaNodeId,
    entry.primaryTerm,
    generationAtRemoval,
  )
}

export async function requestInsyncRemovalWithTargets(
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
  stillWanted?: () => boolean,
): Promise<boolean> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  const result = await sendThroughTargets(
    targets,
    async target => {
      if (stillWanted?.() === false) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
          `The primary no longer wants replica '${replicaNodeId}' of index '${indexName}' partition ${partitionId} removed from the in-sync set, so it sent no removal request`,
          { indexName, partitionId, replicaNodeId, controllerNodeId },
        )
      }
      return requestInsyncRemoval(
        indexName,
        partitionId,
        replicaNodeId,
        primaryTerm,
        target,
        deps.transport,
        deps.nodeId,
      )
    },
    {
      message: `Controller '${controllerNodeId}' did not answer an in-sync removal request for index '${indexName}' partition ${partitionId}`,
      details: { indexName, partitionId, replicaNodeId, controllerNodeId },
    },
  )
  return result.accepted
}
