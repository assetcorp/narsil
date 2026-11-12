import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import type { PartitionAssignment } from '../../coordinator/types'
import { ADMISSION_TIMEOUT_MS } from '../constants'
import type { WriteRoutingDeps } from '../write-routing/types'
import { withdrawAdmission, withTimeout } from './admission'
import { admissionToWithdrawOf, forgetAdmittedReplica, recordRemovedReplica, settleFencedAdmission } from './admitted'
import {
  type AdmissionToWithdraw,
  type CatchUpState,
  getPendingAdmissions,
  partitionKey,
  pendingAdmissionOf,
} from './state'

async function withdrawAppliedAdmission(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  owed: AdmissionToWithdraw,
): Promise<void> {
  owed.withdrawing = true
  const pending = pendingAdmissionOf(state, indexName, partitionId, replicaNodeId)
  try {
    const controllerNodeId = await deps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
    if (controllerNodeId === null) return
    const removal = { indexName, partitionId, replicaNodeId, primaryTerm: owed.primaryTerm }
    const withdrawn = await withTimeout(withdrawAdmission(removal, controllerNodeId, deps), ADMISSION_TIMEOUT_MS, false)
    if (!withdrawn) return
    const stillOwed = admissionToWithdrawOf(state, indexName, partitionId, replicaNodeId) === owed
    settleFencedAdmission(state, indexName, partitionId, replicaNodeId, { pending, owed })
    if (!stillOwed) return
    forgetAdmittedReplica(state, indexName, partitionId, replicaNodeId)
    if (!getPendingAdmissions(state, indexName, partitionId).includes(replicaNodeId)) {
      recordRemovedReplica(state, indexName, partitionId, replicaNodeId, owed.primaryTerm)
    }
  } finally {
    owed.withdrawing = false
  }
}

export function withdrawAppliedAdmissions(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
): Promise<void>[] {
  const owedByReplica = state.admissionsToWithdraw.get(partitionKey(indexName, partitionId))
  if (owedByReplica === undefined) return []
  const started: Promise<void>[] = []
  for (const [replicaNodeId, owed] of [...owedByReplica]) {
    const pending = pendingAdmissionOf(state, indexName, partitionId, replicaNodeId)
    if (owed.primaryTerm !== assignment.primaryTerm) {
      settleFencedAdmission(state, indexName, partitionId, replicaNodeId, { pending, owed })
      continue
    }
    if (owed.withdrawing || (pending !== undefined && !pending.unanswered)) continue
    started.push(withdrawAppliedAdmission(state, deps, indexName, partitionId, replicaNodeId, owed).catch(() => {}))
  }
  return started
}
