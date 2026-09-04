export interface ReplicaCursor {
  appliedSeqNo: number
  sending: boolean
  syncEpoch: number
}

export interface CatchUpState {
  cursors: Map<string, Map<string, ReplicaCursor>>
  pendingAdmissions: Map<string, Set<string>>
  inFlightBytes: number
  timer: ReturnType<typeof setInterval> | null
  activeTick: Promise<void> | null
  stopped: boolean
}

/**
 * Builds the key one partition's replica cursors are stored under.
 *
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @returns The key, which every reader and writer of those cursors shares.
 */
export function partitionKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

/**
 * Builds the state a primary keeps while it feeds the replicas outside the in-sync set.
 *
 * The fresh state holds no cursor, no pending admission, and no timer, so a primary that has never fed a replica
 * costs nothing.
 *
 * @returns The fresh state, ready for {@link startCatchUpPump}.
 */
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

/**
 * Records the position a replica reports for a partition, so that the pump sends it the right entries next.
 *
 * A replica that reports a position ahead of the recorded one has made progress, and the cursor follows it. A
 * replica that reports a position behind the recorded one has lost data and started a new sync session, so the
 * cursor drops to the reported position and the sync epoch rises. Raising the epoch makes the pump discard an
 * acknowledgement still in flight from the session before, because that acknowledgement would otherwise move the
 * cursor back to a position the replica no longer holds.
 *
 * @param state - The catch-up state that holds the cursors.
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param replicaNodeId - The replica that reported the position.
 * @param appliedSeqNo - The highest sequence number the replica reports having applied.
 */
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
    partition.set(replicaNodeId, { appliedSeqNo, sending: false, syncEpoch: 0 })
  } else if (appliedSeqNo > existing.appliedSeqNo) {
    existing.appliedSeqNo = appliedSeqNo
  } else if (appliedSeqNo < existing.appliedSeqNo) {
    existing.appliedSeqNo = appliedSeqNo
    existing.syncEpoch += 1
  }
  state.cursors.set(key, partition)
}

/**
 * Drops everything the primary tracks for one replica of a partition, which is its cursor and any admission it has
 * in flight.
 *
 * The pump calls this once a replica joins the in-sync set, leaves the assignment, or falls behind the retained
 * log, because none of those replicas need feeding from the cursor any longer.
 *
 * @param state - The catch-up state that holds the cursors.
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param replicaNodeId - The replica to forget.
 */
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

/**
 * Lists the replicas of a partition whose admission the primary has proposed and the controller has yet to answer.
 *
 * The write path waits for these replicas alongside the in-sync set, because the controller may admit one of them
 * while a write is in flight, and a write acknowledged without it would then be missing from a member of the set.
 *
 * @param state - The catch-up state that holds the pending admissions.
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @returns The node ids of the replicas whose admission is in flight.
 */
export function getPendingAdmissions(state: CatchUpState, indexName: string, partitionId: number): string[] {
  const pending = state.pendingAdmissions.get(partitionKey(indexName, partitionId))
  return pending === undefined ? [] : [...pending]
}

/**
 * Marks one replica's admission as in flight, and reports whether the caller is the one that marked it.
 *
 * A caller that receives `false` must abandon its proposal, because another one is already waiting for the
 * controller's answer for the same replica.
 *
 * @param state - The catch-up state that holds the pending admissions.
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param replicaNodeId - The replica the primary proposes.
 * @returns True when this call marked the admission, and false when one was already in flight.
 */
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

/**
 * Clears the mark that says one replica's admission is in flight, whatever answer the controller gave.
 *
 * The write path stops waiting for that replica as soon as this returns, so a primary calls it once the admission
 * has settled and never before.
 *
 * @param state - The catch-up state that holds the pending admissions.
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param replicaNodeId - The replica whose admission has settled.
 */
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
