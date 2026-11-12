import type { CatchUpFeed } from './feed'

export interface ReplicaCursor {
  appliedSeqNo: number
  confirmed: boolean
  provenInSyncVersion: number | null
  busy: boolean
  syncEpoch: number
  feed: CatchUpFeed | null
}

export interface SyncSession {
  id: string
  primaryTerm: number
}

export type AdmissionAnswer = 'accepted' | 'refused' | 'unanswered'

export interface PendingAdmission {
  failedWrite: boolean
  unanswered: boolean
  answer: Promise<AdmissionAnswer> | null
}

export interface AdmittedReplica {
  primaryTerm: number
  generation: number
}

export interface AdmissionToWithdraw {
  primaryTerm: number
  withdrawing: boolean
}

export interface OutOfStepRemoval {
  primaryTerm: number
}

export interface CatchUpState {
  cursors: Map<string, Map<string, ReplicaCursor>>
  syncSessions: Map<string, Map<string, SyncSession>>
  pendingAdmissions: Map<string, Map<string, PendingAdmission>>
  admittedReplicas: Map<string, Map<string, AdmittedReplica>>
  admissionsToWithdraw: Map<string, Map<string, AdmissionToWithdraw>>
  acknowledgedSeqNos: Map<string, Map<string, number>>
  removedReplicas: Map<string, Map<string, number>>
  admissionGenerations: Map<string, Map<string, number>>
  lastAdmissionGeneration: number
  startedTerms: Map<string, number>
  outOfStepRemovals: Map<string, OutOfStepRemoval>
  inFlightBytes: number
  timer: ReturnType<typeof setInterval> | null
  activeTick: Promise<void> | null
  replicaWork: Set<Promise<void>>
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
    syncSessions: new Map(),
    pendingAdmissions: new Map(),
    admittedReplicas: new Map(),
    admissionsToWithdraw: new Map(),
    acknowledgedSeqNos: new Map(),
    removedReplicas: new Map(),
    admissionGenerations: new Map(),
    lastAdmissionGeneration: 0,
    startedTerms: new Map(),
    outOfStepRemovals: new Map(),
    inFlightBytes: 0,
    timer: null,
    activeTick: null,
    replicaWork: new Set(),
    stopped: false,
  }
}

function openFreshSyncSession(cursor: ReplicaCursor, appliedSeqNo: number): void {
  cursor.feed?.cancel()
  cursor.appliedSeqNo = appliedSeqNo
  cursor.syncEpoch += 1
}

function noteAcknowledgedPosition(state: CatchUpState, key: string, replicaNodeId: string, appliedSeqNo: number) {
  const acknowledged = state.acknowledgedSeqNos.get(key) ?? new Map<string, number>()
  acknowledged.set(replicaNodeId, appliedSeqNo)
  state.acknowledgedSeqNos.set(key, acknowledged)
}

/**
 * Records the position a replica reports for a partition in a sync request that the primary's log matches, so that
 * the pump sends it the right entries next.
 *
 * The recorded position never passes `logEnd`, the primary's own log end. A request that opens a sync starts a new
 * session, so the cursor takes the reported position whichever way it moves, the sync epoch rises, and the feed in
 * flight is cancelled. Such a request can arrive after a later one, so its position only starts the feed, and the
 * pump proposes the replica only once the replica confirms a position in that session. A request that reports the
 * position after a sync confirms it: a position at or ahead of the recorded one raises the cursor, so a feed or an
 * admission already in flight stays valid, and a position behind the recorded one lowers the cursor and raises the
 * sync epoch as well. Raising the epoch makes the pump discard an acknowledgement still in flight from before the
 * request, and makes the primary withdraw an admission it proposed before it.
 *
 * @param state - The catch-up state that holds the cursors.
 * @param indexName - The index the partition is part of.
 * @param partitionId - The partition's id within that index.
 * @param replicaNodeId - The replica that reported the position.
 * @param appliedSeqNo - The highest sequence number the replica reports having applied.
 * @param logEnd - The primary's own log end for the partition.
 * @param confirmsPosition - True for a request that reports the position after a sync in the replica's current
 *   session, and false for a request that opens a sync.
 */
export function recordReplicaPosition(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  appliedSeqNo: number,
  logEnd: number,
  confirmsPosition: boolean,
): void {
  const key = partitionKey(indexName, partitionId)
  const reported = Math.min(appliedSeqNo, logEnd)
  const partition = state.cursors.get(key) ?? new Map<string, ReplicaCursor>()
  const existing = partition.get(replicaNodeId)
  if (existing === undefined) {
    partition.set(replicaNodeId, {
      appliedSeqNo: reported,
      confirmed: confirmsPosition,
      provenInSyncVersion: null,
      busy: false,
      syncEpoch: 0,
      feed: null,
    })
  } else {
    if (!confirmsPosition || reported < existing.appliedSeqNo) {
      openFreshSyncSession(existing, reported)
    } else {
      existing.appliedSeqNo = reported
    }
    existing.confirmed = confirmsPosition
    existing.provenInSyncVersion = null
  }
  state.cursors.set(key, partition)
  noteAcknowledgedPosition(state, key, replicaNodeId, reported)
}

export function recordSnapshotSyncRequest(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const partition = state.cursors.get(key)
  const existing = partition?.get(replicaNodeId)
  if (partition === undefined || existing === undefined) return
  openFreshSyncSession(existing, 0)
  partition.delete(replicaNodeId)
  if (partition.size === 0) state.cursors.delete(key)
  state.acknowledgedSeqNos.get(key)?.delete(replicaNodeId)
}

/**
 * Drops the cursor that the primary keeps for one replica of a partition, and any admission of that replica that the
 * primary has claimed but not yet sent.
 *
 * The pump calls this once a replica joins the in-sync set, leaves the assignment, or falls behind the retained
 * log, because none of those replicas need feeding from the cursor any longer, and it cancels any feed still in
 * flight to that replica. An admission that the primary has sent stays pending, because the controller can still
 * apply it: the controller's answer settles it, and where no answer arrives, a removal of the replica settles it.
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
    partition.get(replicaNodeId)?.feed?.cancel()
    partition.delete(replicaNodeId)
    if (partition.size === 0) {
      state.cursors.delete(key)
    }
  }
  const pending = pendingAdmissionOf(state, indexName, partitionId, replicaNodeId)
  if (pending !== undefined && pending.answer === null) {
    clearPendingAdmission(state, indexName, partitionId, replicaNodeId, pending)
  }
}

function forgetKeysOfIndex<T>(entries: Map<string, T>, indexName: string): void {
  for (const key of [...entries.keys()]) {
    if (key.slice(0, key.lastIndexOf(':')) === indexName) entries.delete(key)
  }
}

export function forgetCatchUpIndex(state: CatchUpState, indexName: string): void {
  for (const [key, replicas] of [...state.cursors]) {
    if (key.slice(0, key.lastIndexOf(':')) !== indexName) continue
    for (const cursor of replicas.values()) cursor.feed?.cancel()
    state.cursors.delete(key)
  }
  forgetKeysOfIndex(state.syncSessions, indexName)
  forgetKeysOfIndex(state.pendingAdmissions, indexName)
  forgetKeysOfIndex(state.admittedReplicas, indexName)
  forgetKeysOfIndex(state.admissionsToWithdraw, indexName)
  forgetKeysOfIndex(state.acknowledgedSeqNos, indexName)
  forgetKeysOfIndex(state.removedReplicas, indexName)
  forgetKeysOfIndex(state.admissionGenerations, indexName)
  forgetKeysOfIndex(state.startedTerms, indexName)
  forgetKeysOfIndex(state.outOfStepRemovals, indexName)
}

export function forgetOutOfStepRemovalsOfIndex(state: CatchUpState, indexName: string): void {
  for (const key of [...state.outOfStepRemovals.keys()]) {
    if (key.slice(0, key.lastIndexOf(':')) !== indexName) continue
    state.outOfStepRemovals.delete(key)
    state.startedTerms.delete(key)
  }
}

export function feedsReplica(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): boolean {
  const key = partitionKey(indexName, partitionId)
  return (
    state.cursors.get(key)?.has(replicaNodeId) === true || state.pendingAdmissions.get(key)?.has(replicaNodeId) === true
  )
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
  return pending === undefined ? [] : [...pending.keys()]
}

export function pendingAdmissionOf(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): PendingAdmission | undefined {
  return state.pendingAdmissions.get(partitionKey(indexName, partitionId))?.get(replicaNodeId)
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
  const pending = state.pendingAdmissions.get(key) ?? new Map<string, PendingAdmission>()
  if (pending.has(replicaNodeId)) {
    return false
  }
  pending.set(replicaNodeId, { failedWrite: false, unanswered: false, answer: null })
  state.pendingAdmissions.set(key, pending)
  forgetRemovedReplica(state, indexName, partitionId, replicaNodeId)
  advanceAdmissionGeneration(state, indexName, partitionId, replicaNodeId)
  return true
}

export function advanceAdmissionGeneration(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): number {
  const key = partitionKey(indexName, partitionId)
  const generations = state.admissionGenerations.get(key) ?? new Map<string, number>()
  state.lastAdmissionGeneration += 1
  generations.set(replicaNodeId, state.lastAdmissionGeneration)
  state.admissionGenerations.set(key, generations)
  return state.lastAdmissionGeneration
}

export function admissionGenerationOf(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): number {
  const current = state.admissionGenerations.get(partitionKey(indexName, partitionId))?.get(replicaNodeId)
  return current ?? advanceAdmissionGeneration(state, indexName, partitionId, replicaNodeId)
}

export function admissionGenerationIs(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  generation: number,
): boolean {
  return state.admissionGenerations.get(partitionKey(indexName, partitionId))?.get(replicaNodeId) === generation
}

export function forgetRemovedReplica(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const removed = state.removedReplicas.get(key)
  if (removed === undefined) return
  removed.delete(replicaNodeId)
  if (removed.size === 0) state.removedReplicas.delete(key)
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
 * @param claim - The mark that the caller set, when the caller must leave a later mark for the same replica alone.
 */
export function clearPendingAdmission(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  claim?: PendingAdmission,
): void {
  const key = partitionKey(indexName, partitionId)
  const pending = state.pendingAdmissions.get(key)
  if (pending === undefined || (claim !== undefined && pending.get(replicaNodeId) !== claim)) {
    return
  }
  pending.delete(replicaNodeId)
  if (pending.size === 0) {
    state.pendingAdmissions.delete(key)
  }
}
