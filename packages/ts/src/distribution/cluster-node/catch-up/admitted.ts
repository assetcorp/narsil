import type { PartitionAssignment } from '../../coordinator/types'
import {
  type AdmittedReplica,
  admissionGenerationIs,
  type CatchUpState,
  partitionKey,
  recordRemovedReplica,
} from './state'

export function recordAdmittedReplica(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  tableVersion: number | null,
): void {
  const key = partitionKey(indexName, partitionId)
  const admitted = state.admittedReplicas.get(key) ?? new Map<string, AdmittedReplica>()
  admitted.set(replicaNodeId, { primaryTerm, tableVersion })
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
  tableVersion?: number,
): string[] {
  const admitted = state.admittedReplicas.get(partitionKey(indexName, partitionId))
  if (admitted === undefined) return []
  const beyond: string[] = []
  for (const [replicaNodeId, record] of [...admitted]) {
    const settled = assignment.inSyncSet.includes(replicaNodeId) || !assignment.replicas.includes(replicaNodeId)
    const superseded = record.tableVersion !== null && tableVersion !== undefined && tableVersion >= record.tableVersion
    if (settled || superseded || record.primaryTerm !== assignment.primaryTerm) {
      forgetAdmittedReplica(state, indexName, partitionId, replicaNodeId)
      continue
    }
    beyond.push(replicaNodeId)
  }
  return beyond
}
