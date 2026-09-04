import type { WorkerPool, WorkerReplacement } from '../../workers/pool'
import { createRequestId, type WorkerAction } from '../../workers/protocol'
import { loadIndexOntoWorkers } from '../worker-resync'
import { POOL_RESTART_DELAY_MAX_MS, POOL_RESTART_DELAY_MS } from './constants'
import { enqueueReplication } from './replication'
import type { OrchestratorState } from './types'

export const COPY_RESTART_REASON = 'A request arrived after every worker crashed and the restart delay passed'

export function nextRestartDelay(state: OrchestratorState): number {
  const delay = state.poolRetryDelayMs
  state.poolRetryDelayMs = Math.min(delay * 2, POOL_RESTART_DELAY_MAX_MS)
  return delay
}

export function deferPoolRestart(state: OrchestratorState): void {
  state.poolRetryAt = Date.now() + nextRestartDelay(state)
}

export function retirePool(state: OrchestratorState, pool: WorkerPool): void {
  if (state.workerPool !== pool) return
  state.workerPool = null
  cancelRepair(state)
  deferPoolRestart(state)
  for (const indexName of state.scaledOutIndexes) state.droppedCopies.set(indexName, COPY_RESTART_REASON)
  state.scaledOutIndexes.clear()
  state.segmentLedger.clear()
  void pool.shutdown().catch(() => undefined)
}

export function handleWorkerCrash(
  state: OrchestratorState,
  pool: WorkerPool,
  workerId: number,
  indexNames: string[],
  error: Error,
): void {
  state.callbacks?.onWorkerCrash?.(workerId, indexNames, error)
  if (pool.getAllExecutors().length === 0) {
    retirePool(state, pool)
    return
  }
  scheduleRepair(state, pool)
}

export function scheduleRepair(state: OrchestratorState, pool: WorkerPool): void {
  if (state.workerPool !== pool || state.repairTimer !== null || state.poolRepair !== null) return
  const timer = setTimeout(() => {
    state.repairTimer = null
    void repairPool(state, pool)
  }, state.poolRetryDelayMs)
  if (typeof timer.unref === 'function') timer.unref()
  state.repairTimer = timer
}

export function cancelRepair(state: OrchestratorState): void {
  if (state.repairTimer === null) return
  clearTimeout(state.repairTimer)
  state.repairTimer = null
}

async function loadOntoReplacement(
  state: OrchestratorState,
  replacement: WorkerReplacement,
  indexName: string,
): Promise<void> {
  const entry = state.indexRegistry.get(indexName)
  const manager = state.executor.getManager(indexName)
  if (entry === undefined || manager === undefined || !state.scaledOutIndexes.has(indexName)) return
  const buffered: WorkerAction[] = []
  state.copyLoadBuffers.set(indexName, buffered)
  try {
    await loadIndexOntoWorkers(indexName, [replacement.executor], entry.config, manager)
    replacement.hold(indexName)
  } finally {
    state.copyLoadBuffers.delete(indexName)
    for (const action of buffered) enqueueReplication(state, indexName, action)
  }
}

async function replaceWorker(state: OrchestratorState, pool: WorkerPool, workerId: number): Promise<void> {
  const replacement = pool.spawnReplacement(workerId)
  if (replacement === null) return
  try {
    if (state.bootstrapModule !== undefined) {
      await replacement.executor.execute({
        type: 'bootstrap',
        moduleUrl: state.bootstrapModule,
        requestId: createRequestId(),
      })
    }
    for (const indexName of [...state.scaledOutIndexes]) {
      await loadOntoReplacement(state, replacement, indexName)
    }
    replacement.admit()
  } catch (err) {
    replacement.abandon()
    throw err
  }
}

async function replaceDeadWorkers(state: OrchestratorState, pool: WorkerPool): Promise<void> {
  for (const workerId of pool.deadWorkerIds()) {
    if (state.workerPool !== pool) return
    await replaceWorker(state, pool, workerId)
  }
  state.poolRetryDelayMs = POOL_RESTART_DELAY_MS
}

export function repairPool(state: OrchestratorState, pool: WorkerPool): Promise<void> {
  if (state.workerPool !== pool) return Promise.resolve()
  if (state.poolRepair !== null) return state.poolRepair
  const run = replaceDeadWorkers(state, pool)
    .catch(err => {
      nextRestartDelay(state)
      console.warn('Replacing a crashed worker failed:', err)
    })
    .finally(() => {
      state.poolRepair = null
      if (pool.deadWorkerIds().length > 0) scheduleRepair(state, pool)
    })
  state.poolRepair = run
  return run
}
