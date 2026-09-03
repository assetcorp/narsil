import { cancelIdleMerge } from './compaction'
import { awaitReplicationIdle } from './replication'
import { COPY_RELOAD_REASON, copiesAllowed, copyThresholdReason, indexReadyForCopies, scaleOutIndex } from './scale-out'
import type { OrchestratorState } from './types'

export const DEFAULT_COPY_IDLE_TIMEOUT_MS = 300_000
const MIN_SWEEP_INTERVAL_MS = 100
const MAX_SWEEP_INTERVAL_MS = 60_000

export function isIndexBusy(state: OrchestratorState, indexName: string): boolean {
  return (
    state.copyTransitions.has(indexName) ||
    state.replicationQueues.has(indexName) ||
    state.compactionsInFlight.has(indexName)
  )
}

export function noteAccess(state: OrchestratorState, indexName: string): void {
  state.lastAccessAt.set(indexName, Date.now())
  if (!copiesAllowed(state)) return
  const reloadReason = state.droppedCopies.get(indexName)
  if (reloadReason !== undefined) {
    const transition = state.copyTransitions.get(indexName)
    if (transition !== undefined && transition.kind !== 'drop') return
    void scaleOutIndex(state, indexName, reloadReason)
    return
  }
  if (indexReadyForCopies(state, indexName)) {
    void scaleOutIndex(state, indexName, copyThresholdReason(state, indexName))
  }
}

async function releaseCopies(state: OrchestratorState, indexName: string): Promise<void> {
  const pool = state.workerPool
  if (pool === null) return
  await awaitReplicationIdle(state, indexName)
  const cutoff = Date.now() - state.copyIdleTimeoutMs
  if ((state.lastAccessAt.get(indexName) ?? Date.now()) > cutoff) return
  if (!state.scaledOutIndexes.has(indexName) || state.compactionsInFlight.has(indexName)) return

  state.scaledOutIndexes.delete(indexName)
  state.droppedCopies.set(indexName, COPY_RELOAD_REASON)
  cancelIdleMerge(state, indexName)
  const outcomes = await Promise.allSettled(
    pool
      .getAllExecutors()
      .map(worker => worker.execute({ type: 'dropIndex', indexName, requestId: `idle-drop-${indexName}` })),
  )
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') console.warn('Dropping an idle worker copy failed:', outcome.reason)
  }
  pool.removeIndex(indexName)
  state.segmentLedger.delete(indexName)
}

export async function dropIdleCopies(state: OrchestratorState, indexName: string): Promise<void> {
  const previous = state.copyTransitions.get(indexName)
  if (previous !== undefined) return
  const done = releaseCopies(state, indexName)
    .catch(err => {
      console.warn('Dropping idle worker copies failed:', err)
    })
    .finally(() => {
      if (state.copyTransitions.get(indexName)?.done === done) state.copyTransitions.delete(indexName)
    })
  state.copyTransitions.set(indexName, { kind: 'drop', done })
  await done
}

async function sweepIdleCopies(state: OrchestratorState): Promise<void> {
  const cutoff = Date.now() - state.copyIdleTimeoutMs
  for (const indexName of [...state.scaledOutIndexes]) {
    if ((state.lastAccessAt.get(indexName) ?? Date.now()) > cutoff) continue
    if (isIndexBusy(state, indexName)) continue
    await dropIdleCopies(state, indexName)
  }
}

export function startIdleSweep(state: OrchestratorState): void {
  if (!state.workersEnabled || state.idleSweep !== null) return
  const interval = Math.min(MAX_SWEEP_INTERVAL_MS, Math.max(MIN_SWEEP_INTERVAL_MS, state.copyIdleTimeoutMs / 2))
  const timer = setInterval(() => void sweepIdleCopies(state).catch(() => undefined), interval)
  if (typeof timer.unref === 'function') timer.unref()
  state.idleSweep = timer
}

export function stopIdleSweep(state: OrchestratorState): void {
  if (state.idleSweep === null) return
  clearInterval(state.idleSweep)
  state.idleSweep = null
}
