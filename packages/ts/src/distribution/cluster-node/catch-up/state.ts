export const CATCH_UP_TICK_MS = 1_000
export const CATCH_UP_IN_FLIGHT_BYTE_CEILING = 67_108_864

export interface ReplicaCursor {
  appliedSeqNo: number
  sending: boolean
}

export interface CatchUpState {
  cursors: Map<string, Map<string, ReplicaCursor>>
  pendingAdmissions: Map<string, Set<string>>
  inFlightBytes: number
  timer: ReturnType<typeof setInterval> | null
  activeTick: Promise<void> | null
  stopped: boolean
}

export function partitionKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function createCatchUpState(): CatchUpState {
  return {
    cursors: new Map(),
    pendingAdmissions: new Map(),
    inFlightBytes: 0,
    timer: null,
    activeTick: null,
    stopped: false,
  }
}

export function recordReplicaPosition(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  appliedSeqNo: number,
): void {
  const key = partitionKey(indexName, partitionId)
  const partition = state.cursors.get(key) ?? new Map<string, ReplicaCursor>()
  const existing = partition.get(replicaNodeId)
  if (existing === undefined) {
    partition.set(replicaNodeId, { appliedSeqNo, sending: false })
  } else if (appliedSeqNo > existing.appliedSeqNo) {
    existing.appliedSeqNo = appliedSeqNo
  }
  state.cursors.set(key, partition)
}

export function forgetReplica(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const partition = state.cursors.get(key)
  if (partition !== undefined) {
    partition.delete(replicaNodeId)
    if (partition.size === 0) {
      state.cursors.delete(key)
    }
  }
  clearPendingAdmission(state, indexName, partitionId, replicaNodeId)
}

export function getPendingAdmissions(state: CatchUpState, indexName: string, partitionId: number): string[] {
  const pending = state.pendingAdmissions.get(partitionKey(indexName, partitionId))
  return pending === undefined ? [] : [...pending]
}

export function markPendingAdmission(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): boolean {
  const key = partitionKey(indexName, partitionId)
  const pending = state.pendingAdmissions.get(key) ?? new Set<string>()
  if (pending.has(replicaNodeId)) {
    return false
  }
  pending.add(replicaNodeId)
  state.pendingAdmissions.set(key, pending)
  return true
}

export function clearPendingAdmission(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const pending = state.pendingAdmissions.get(key)
  if (pending === undefined) {
    return
  }
  pending.delete(replicaNodeId)
  if (pending.size === 0) {
    state.pendingAdmissions.delete(key)
  }
}
