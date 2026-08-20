import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import type { PartitionAssignment } from '../../coordinator/types'
import { requestInsyncAdmission } from '../../replication/insync'
import type { InsyncAddPayload } from '../../transport/types'
import { resolveNodeTargets } from '../write-routing/assignment'
import type { WriteRoutingDeps } from '../write-routing/types'
import { type CatchUpState, clearPendingAdmission, markPendingAdmission, type ReplicaCursor } from './state'

export const ADMISSION_TIMEOUT_MS = 10_000

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

    await withTimeout(sendToController(payload, controllerNodeId, deps), ADMISSION_TIMEOUT_MS, false)
  } finally {
    clearPendingAdmission(state, indexName, partitionId, replicaNodeId)
  }
}
