import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import { inSyncVersionOf } from '../../cluster/in-sync-version'
import type { PartitionAssignment } from '../../coordinator/types'
import { requestInsyncAdmission, requestInsyncRemoval } from '../../replication/insync'
import type { InsyncAddPayload, InsyncRemovePayload } from '../../transport/types'
import { ADMISSION_RETRIES_AFTER_IN_SYNC_CHANGE, ADMISSION_TIMEOUT_MS } from '../constants'
import { resolveNodeTargets } from '../write-routing/assignment'
import type { WriteRoutingDeps } from '../write-routing/types'
import { forgetAdmissionToWithdraw, recordAdmissionToWithdraw, recordAdmittedReplica } from './admitted'
import {
  type AdmissionAnswer,
  advanceAdmissionGeneration,
  type CatchUpState,
  clearPendingAdmission,
  forgetRemovedReplica,
  markPendingAdmission,
  type PendingAdmission,
  pendingAdmissionOf,
  type ReplicaCursor,
} from './state'

interface AdmissionClaim {
  state: CatchUpState
  deps: WriteRoutingDeps
  cursor: ReplicaCursor
  proposedEpoch: number
  pending: PendingAdmission
}

async function sendToController(
  payload: InsyncAddPayload,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
): Promise<AdmissionAnswer> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  let sentWithoutAnswer = false
  for (const target of targets) {
    try {
      const result = await requestInsyncAdmission(payload, target, deps.transport, deps.nodeId)
      if (result.accepted) return 'accepted'
      return sentWithoutAnswer ? 'unanswered' : 'refused'
    } catch (_) {
      sentWithoutAnswer = true
    }
  }
  return 'unanswered'
}

export function withTimeout<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
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

export async function withdrawAdmission(
  removal: InsyncRemovePayload,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
): Promise<boolean> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  for (const target of targets) {
    try {
      const result = await requestInsyncRemoval(
        removal.indexName,
        removal.partitionId,
        removal.replicaNodeId,
        removal.primaryTerm,
        target,
        deps.transport,
        deps.nodeId,
      )
      if (result.accepted) {
        return true
      }
    } catch (_) {}
  }
  return false
}

function claimHolds(claim: AdmissionClaim, payload: InsyncAddPayload): boolean {
  const current = pendingAdmissionOf(claim.state, payload.indexName, payload.partitionId, payload.replicaNodeId)
  return current === claim.pending && !claim.pending.failedWrite && claim.cursor.syncEpoch === claim.proposedEpoch
}

async function changedInSyncVersion(claim: AdmissionClaim, payload: InsyncAddPayload): Promise<number | null> {
  const { deps } = claim
  let assignment: PartitionAssignment | undefined
  try {
    const table = await (deps.readLiveAllocation?.(payload.indexName) ??
      deps.coordinator.getAllocation(payload.indexName))
    assignment = table?.assignments.get(payload.partitionId)
  } catch (_) {
    return null
  }
  if (assignment === undefined) return null
  const inSyncVersion = inSyncVersionOf(assignment)
  const qualifies =
    inSyncVersion !== payload.inSyncVersion &&
    assignment.primary === deps.nodeId &&
    assignment.primaryTerm === payload.primaryTerm &&
    assignment.state === 'ACTIVE' &&
    assignment.replicas.includes(payload.replicaNodeId) &&
    !assignment.inSyncSet.includes(payload.replicaNodeId) &&
    payload.appliedSeqNo >= assignment.commitPoint
  return qualifies ? inSyncVersion : null
}

async function askController(
  claim: AdmissionClaim,
  payload: InsyncAddPayload,
  controllerNodeId: string,
): Promise<AdmissionAnswer> {
  let request = payload
  let retries = 0
  while (claimHolds(claim, request)) {
    const answer = await withTimeout(
      sendToController(request, controllerNodeId, claim.deps),
      ADMISSION_TIMEOUT_MS,
      'unanswered',
    )
    if (answer !== 'refused' || retries >= ADMISSION_RETRIES_AFTER_IN_SYNC_CHANGE) return answer
    const inSyncVersion = await changedInSyncVersion(claim, request)
    if (inSyncVersion === null) return answer
    request = { ...request, inSyncVersion }
    retries += 1
  }
  return 'refused'
}

/**
 * Asks the controller to admit a replica that has caught up with the local log, and keeps the write path waiting
 * for that replica until the controller answers.
 *
 * The primary proposes nothing for a replica whose applied position is below the partition's commit point, or whose
 * position the replica has yet to confirm in its current sync session, because such a replica can lack a write the
 * cluster has already acknowledged. Each request carries the `inSyncVersion` of the assignment that the primary read,
 * and a refused request whose version the allocation table no longer holds is read again and sent again while the
 * replica still qualifies. A replica that reports a lower position while the proposal is in flight has started a fresh
 * sync session, and the primary then asks the controller to remove it again, because the position the proposal
 * carried no longer describes it. A write that the replica fails while the proposal is in flight leaves the replica
 * to the write path, which waits for the answer and removes the replica where the controller admitted it. A proposal
 * whose answer never arrives stays pending, so the write path keeps sending the replica every entry, until a removal
 * of the replica raises the partition's `inSyncVersion` and so fences the request that the controller may still apply.
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
  if (claimAdmission(state, deps, indexName, partitionId, replicaNodeId, cursor)) {
    await requestClaimedAdmission(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor)
  }
}

export function claimAdmission(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  cursor: ReplicaCursor,
): boolean {
  const log = deps.getReplicationLog(indexName, partitionId)
  if (!cursor.confirmed || cursor.appliedSeqNo < log.commitPoint) {
    return false
  }
  return markPendingAdmission(state, indexName, partitionId, replicaNodeId)
}

export async function requestClaimedAdmission(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  replicaNodeId: string,
  cursor: ReplicaCursor,
): Promise<void> {
  const pending = pendingAdmissionOf(state, indexName, partitionId, replicaNodeId)
  if (pending === undefined) return
  let settle: (answer: AdmissionAnswer) => void = () => {}
  pending.answer = new Promise<AdmissionAnswer>(resolve => {
    settle = resolve
  })
  const claim: AdmissionClaim = { state, deps, cursor, proposedEpoch: cursor.syncEpoch, pending }
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
      commitPoint: deps.getReplicationLog(indexName, partitionId).commitPoint,
      inSyncVersion: inSyncVersionOf(assignment),
    }

    const answer = await askController(claim, payload, controllerNodeId)
    pending.unanswered = answer === 'unanswered'
    settle(answer)
    if (answer === 'accepted' && pending.failedWrite) {
      recordAdmissionToWithdraw(state, indexName, partitionId, replicaNodeId, assignment.primaryTerm)
      return
    }
    const outlived = answer === 'accepted' && cursor.syncEpoch !== claim.proposedEpoch
    const withdrawn =
      outlived && (await withTimeout(withdrawAdmission(payload, controllerNodeId, deps), ADMISSION_TIMEOUT_MS, false))
    if (answer === 'unanswered' || (outlived && !withdrawn)) {
      recordAdmissionToWithdraw(state, indexName, partitionId, replicaNodeId, assignment.primaryTerm)
    } else if (answer === 'accepted' && !outlived) {
      forgetAdmissionToWithdraw(state, indexName, partitionId, replicaNodeId)
      forgetRemovedReplica(state, indexName, partitionId, replicaNodeId)
      recordAdmittedReplica(
        state,
        indexName,
        partitionId,
        replicaNodeId,
        assignment.primaryTerm,
        advanceAdmissionGeneration(state, indexName, partitionId, replicaNodeId),
      )
    }
  } finally {
    settle('refused')
    if (!pending.unanswered) clearPendingAdmission(state, indexName, partitionId, replicaNodeId, pending)
  }
}
