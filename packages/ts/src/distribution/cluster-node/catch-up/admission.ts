import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import type { PartitionAssignment } from '../../coordinator/types'
import { requestInsyncAdmission, requestInsyncRemoval } from '../../replication/insync'
import type { InsyncAddPayload } from '../../transport/types'
import { ADMISSION_TIMEOUT_MS } from '../constants'
import { resolveNodeTargets } from '../write-routing/assignment'
import type { WriteRoutingDeps } from '../write-routing/types'
import { type CatchUpState, clearPendingAdmission, markPendingAdmission, type ReplicaCursor } from './state'

async function sendToController(
  payload: InsyncAddPayload,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
): Promise<boolean> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  for (const target of targets) {
    try {
      const result = await requestInsyncAdmission(payload, target, deps.transport, deps.nodeId)
      return result.accepted
    } catch (_) {}
  }
  return false
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref?.()
    work
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

async function withdrawAdmission(
  payload: InsyncAddPayload,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
): Promise<void> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  for (const target of targets) {
    try {
      const result = await requestInsyncRemoval(
        payload.indexName,
        payload.partitionId,
        payload.replicaNodeId,
        payload.primaryTerm,
        target,
        deps.transport,
        deps.nodeId,
      )
      if (result.accepted) {
        return
      }
    } catch (_) {}
  }
}

/**
 * Asks the controller to admit a replica that has caught up with the local log, and keeps the write path waiting
 * for that replica until the controller answers.
 *
 * The primary proposes nothing for a replica whose applied position is below the partition's commit point,
 * because such a replica lacks a write the cluster has already acknowledged. A replica that reports a lower
 * position while the proposal is in flight has started a fresh sync session, and the primary then asks the
 * controller to remove it again, because the position the proposal carried no longer describes it.
 *
 * @param state - The catch-up state that holds the cursors and the pending admissions.
 * @param deps - The write routing dependencies, which give the proposal the coordinator and the transport.
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param assignment - The partition assignment the pump read for this tick.
 * @param replicaNodeId - The replica the primary proposes.
 * @param cursor - The replica's cursor, which states its applied position and its sync epoch.
 * @returns A promise that settles once the admission has settled, whichever way it went.
 */
export async function proposeAdmission(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  replicaNodeId: string,
  cursor: ReplicaCursor,
): Promise<void> {
  const log = deps.getReplicationLog(indexName, partitionId)
  if (cursor.appliedSeqNo < log.commitPoint) {
    return
  }

  if (!markPendingAdmission(state, indexName, partitionId, replicaNodeId)) {
    return
  }

  const proposedEpoch = cursor.syncEpoch
  try {
    const controllerNodeId = await deps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
    if (controllerNodeId === null) {
      return
    }

    const payload: InsyncAddPayload = {
      indexName,
      partitionId,
      replicaNodeId,
      primaryTerm: assignment.primaryTerm,
      appliedSeqNo: cursor.appliedSeqNo,
      commitPoint: log.commitPoint,
    }

    const accepted = await withTimeout(sendToController(payload, controllerNodeId, deps), ADMISSION_TIMEOUT_MS, false)
    if (accepted && cursor.syncEpoch !== proposedEpoch) {
      await withTimeout(withdrawAdmission(payload, controllerNodeId, deps), ADMISSION_TIMEOUT_MS, undefined)
    }
  } finally {
    clearPendingAdmission(state, indexName, partitionId, replicaNodeId)
  }
}
