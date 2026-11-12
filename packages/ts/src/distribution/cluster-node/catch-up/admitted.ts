import type { PartitionAssignment } from '../../coordinator/types'
import {
  type AdmissionToWithdraw,
  type AdmittedReplica,
  admissionGenerationIs,
  type CatchUpState,
  clearPendingAdmission,
  type PendingAdmission,
  partitionKey,
} from './state'

export function admissionToWithdrawOf(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): AdmissionToWithdraw | undefined {
  return state.admissionsToWithdraw.get(partitionKey(indexName, partitionId))?.get(replicaNodeId)
}

export function settleFencedAdmission(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  fenced: { pending: PendingAdmission | undefined; owed: AdmissionToWithdraw | undefined },
): void {
  if (fenced.pending?.unanswered === true) {
    clearPendingAdmission(state, indexName, partitionId, replicaNodeId, fenced.pending)
  }
  if (
    fenced.owed !== undefined &&
    admissionToWithdrawOf(state, indexName, partitionId, replicaNodeId) === fenced.owed
  ) {
    forgetAdmissionToWithdraw(state, indexName, partitionId, replicaNodeId)
  }
}

export function recordAdmissionToWithdraw(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
): void {
  const key = partitionKey(indexName, partitionId)
  const owed = state.admissionsToWithdraw.get(key) ?? new Map<string, AdmissionToWithdraw>()
  owed.set(replicaNodeId, { primaryTerm, withdrawing: false })
  state.admissionsToWithdraw.set(key, owed)
}

export function forgetAdmissionToWithdraw(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const owed = state.admissionsToWithdraw.get(key)
  if (owed === undefined) return
  owed.delete(replicaNodeId)
  if (owed.size === 0) state.admissionsToWithdraw.delete(key)
}

export function recordRemovedReplica(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
): void {
  const key = partitionKey(indexName, partitionId)
  const removed = state.removedReplicas.get(key) ?? new Map<string, number>()
  removed.set(replicaNodeId, primaryTerm)
  state.removedReplicas.set(key, removed)
}

export function withoutRemovedReplicas(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  primaryTerm: number,
  targets: string[],
): string[] {
  const removed = state.removedReplicas.get(partitionKey(indexName, partitionId))
  if (removed === undefined) return targets
  return targets.filter(replicaNodeId => removed.get(replicaNodeId) !== primaryTerm)
}

export function recordAdmittedReplica(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  generation: number,
): void {
  const key = partitionKey(indexName, partitionId)
  const admitted = state.admittedReplicas.get(key) ?? new Map<string, AdmittedReplica>()
  admitted.set(replicaNodeId, { primaryTerm, generation })
  state.admittedReplicas.set(key, admitted)
}

export function forgetAdmittedReplica(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const admitted = state.admittedReplicas.get(key)
  if (admitted === undefined) return
  admitted.delete(replicaNodeId)
  if (admitted.size === 0) state.admittedReplicas.delete(key)
}

export function recordRemovalUnlessReadmitted(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  generationAtRemoval: number,
): void {
  if (!admissionGenerationIs(state, indexName, partitionId, replicaNodeId, generationAtRemoval)) return
  forgetAdmittedReplica(state, indexName, partitionId, replicaNodeId)
  recordRemovedReplica(state, indexName, partitionId, replicaNodeId, primaryTerm)
}

export function admittedBeyondTable(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  generationAtLiveRead?: number,
): string[] {
  const admitted = state.admittedReplicas.get(partitionKey(indexName, partitionId))
  if (admitted === undefined) return []
  const beyond: string[] = []
  for (const [replicaNodeId, record] of [...admitted]) {
    const settled = assignment.inSyncSet.includes(replicaNodeId) || !assignment.replicas.includes(replicaNodeId)
    const superseded = generationAtLiveRead !== undefined && record.generation <= generationAtLiveRead
    if (settled || superseded || record.primaryTerm !== assignment.primaryTerm) {
      forgetAdmittedReplica(state, indexName, partitionId, replicaNodeId)
      continue
    }
    beyond.push(replicaNodeId)
  }
  return beyond
}
