import type { WorkerPool } from '../../workers/pool'
import { resolveRequestThreadCount, resolveWorkerCount } from '../../workers/worker-count'
import { LONG_QUERY_THREADS } from './constants'
import { retirePool } from './repair'
import { copyThresholdReason, ensurePool, indexReadyForCopies, scaleOutIndex, scaleOutReadyIndexes } from './scale-out'
import type { OrchestratorState, RequestThreadListener } from './types'
import { refreshVectorCopies, sharedCopyHostOf } from './vector-copies'

export async function announceRequestThreads(state: OrchestratorState, pool: WorkerPool): Promise<void> {
  const listener = state.requestThreads
  if (listener === null) return
  const entries = pool.executorEntries()
  for (const { workerId, executor } of entries) {
    if (pool.isLongQueryWorker(workerId)) await listener.onLongQueryWorkerReady(workerId, executor)
  }
  for (const { workerId, executor } of entries) {
    if (!pool.isLongQueryWorker(workerId)) await listener.onWorkerReady(workerId, executor)
  }
}

export function scheduleRequestThreadPoolRestart(state: OrchestratorState): void {
  if (state.requestThreads === null) return
  const timer = setTimeout(
    () => {
      if (state.requestThreads === null || state.workerPool !== null) return
      void ensurePool(state)
        .then(() => scaleOutReadyIndexes(state))
        .catch(err => {
          console.warn('Restarting the request threads failed:', err)
          scheduleRequestThreadPoolRestart(state)
        })
    },
    Math.max(0, state.poolRetryAt - Date.now()),
  )
  if (typeof timer.unref === 'function') timer.unref()
}

export async function serveRequestsOnWorkers(
  state: OrchestratorState,
  listener: RequestThreadListener,
): Promise<number> {
  if (!state.workersEnabled) return 0
  state.requestThreads = listener
  state.keywordWorkerCount = resolveRequestThreadCount(state.config?.workers?.count)
  state.longQueryWorkerCount = LONG_QUERY_THREADS
  if (state.vectorCopyPolicy !== undefined) {
    state.vectorCopyPolicy.host = sharedCopyHostOf(state)
    state.vectorCopyPolicy.enabled = state.workersEnabled
  }

  if (state.poolStart !== null) await state.poolStart.catch(() => undefined)
  const running = state.workerPool
  if (running !== null && running.workerCount !== resolveWorkerCount(state.keywordWorkerCount + LONG_QUERY_THREADS)) {
    retirePool(state, running)
    state.poolRetryAt = 0
  }
  const pool = await ensurePool(state)
  for (const indexName of state.indexRegistry.keys()) {
    refreshVectorCopies(state, indexName)
    if (indexReadyForCopies(state, indexName)) {
      await scaleOutIndex(state, indexName, copyThresholdReason(state, indexName))
    }
  }
  return pool.workerCount
}

export function requestThreadCountOf(state: OrchestratorState): number {
  if (!state.workersEnabled) return 0
  return resolveRequestThreadCount(state.config?.workers?.count)
}

export function stopRequestThreads(state: OrchestratorState): void {
  const listener = state.requestThreads
  if (listener === null) return
  state.requestThreads = null
  const pool = state.workerPool
  if (pool === null) return
  for (const { workerId } of pool.executorEntries()) listener.onWorkerGone(workerId)
}
