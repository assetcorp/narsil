import { createWorkerFactory } from '#platform/worker-factory'
import { createWorkerPool, type WorkerPool } from '../../workers/pool'
import type { WorkerAction } from '../../workers/protocol'
import { transferIndexToPool } from '../worker-resync'
import {
  eligibleIndexNames,
  isDeterministicFailure,
  reportIneligible,
  toError,
  workerIneligibility,
} from './eligibility'
import { enqueueReplication } from './replication'
import type { OrchestratorState } from './types'

export const COPY_RELOAD_REASON = 'A request arrived after an idle spell dropped the worker copies'

async function startPool(state: OrchestratorState): Promise<WorkerPool> {
  eligibleIndexNames(state)
  const factory = await createWorkerFactory()
  const pool = createWorkerPool({
    count: state.keywordWorkerCount,
    workerFactory: factory,
    onWorkerCrash(workerId, indexNames, error) {
      state.callbacks?.onWorkerCrash?.(workerId, indexNames, error)
    },
  })
  try {
    pool.spawnAll()
    if (state.bootstrapModule !== undefined) {
      const moduleUrl = state.bootstrapModule
      await Promise.all(
        pool
          .getAllExecutors()
          .map(workerExecutor =>
            workerExecutor.execute({ type: 'bootstrap', moduleUrl, requestId: 'copies-bootstrap' }),
          ),
      )
    }
  } catch (err) {
    await pool.shutdown().catch(() => undefined)
    throw err
  }
  return pool
}

async function ensurePool(state: OrchestratorState): Promise<WorkerPool> {
  if (state.workerPool !== null) return state.workerPool
  if (state.poolStart === null) {
    state.poolStart = startPool(state).then(
      pool => {
        state.workerPool = pool
        state.poolStart = null
        return pool
      },
      err => {
        state.poolStart = null
        throw err
      },
    )
  }
  return state.poolStart
}

function documentCountOf(state: OrchestratorState, indexName: string): number {
  return state.executor.getManager(indexName)?.countDocuments() ?? 0
}

export function copyThresholdReason(state: OrchestratorState, indexName: string): string {
  return `Index "${indexName}" holds ${documentCountOf(state, indexName)} documents, reaching the copy threshold of ${state.copyThreshold}`
}

export function indexReadyForCopies(state: OrchestratorState, indexName: string, incomingCount = 0): boolean {
  if (!state.workersEnabled || state.scaleOutBlocked) return false
  if (state.scaledOutIndexes.has(indexName) || state.desyncedIndexes.has(indexName)) return false
  if (state.copyTransitions.has(indexName)) return false
  if (state.callbacks?.shouldDeferCopies?.()) return false
  const entry = state.indexRegistry.get(indexName)
  if (entry === undefined || state.executor.getManager(indexName) === undefined) return false
  if (documentCountOf(state, indexName) + incomingCount < state.copyThreshold) return false
  const ineligibility = workerIneligibility(indexName, entry.config, state.bootstrapModule)
  if (ineligibility !== null) {
    reportIneligible(state, indexName, ineligibility)
    return false
  }
  return true
}

async function loadCopies(state: OrchestratorState, indexName: string, reason: string): Promise<void> {
  const entry = state.indexRegistry.get(indexName)
  const manager = state.executor.getManager(indexName)
  if (entry === undefined || manager === undefined) return
  const ineligibility = workerIneligibility(indexName, entry.config, state.bootstrapModule)
  if (ineligibility !== null) {
    reportIneligible(state, indexName, ineligibility)
    return
  }

  const pool = await ensurePool(state)
  if (state.executor.getManager(indexName) === undefined) return
  const reload = state.idleDroppedIndexes.delete(indexName)
  const buffered: WorkerAction[] = []
  state.copyLoadBuffers.set(indexName, buffered)
  try {
    await transferIndexToPool(indexName, pool, entry.config, manager)
    state.scaledOutIndexes.add(indexName)
    state.lastAccessAt.set(indexName, Date.now())
    for (const action of buffered) enqueueReplication(state, indexName, action)
  } finally {
    state.copyLoadBuffers.delete(indexName)
  }
  if (reload) state.copyReloadCounts.set(indexName, (state.copyReloadCounts.get(indexName) ?? 0) + 1)
  state.callbacks?.onCopiesLoaded?.(pool.workerCount, reason)
}

export async function scaleOutIndex(state: OrchestratorState, indexName: string, reason: string): Promise<void> {
  const previous = state.copyTransitions.get(indexName)
  if (previous !== undefined) await previous
  if (!state.workersEnabled || state.scaleOutBlocked) return
  if (state.scaledOutIndexes.has(indexName) || state.desyncedIndexes.has(indexName)) return

  const run = loadCopies(state, indexName, reason)
    .catch(err => {
      const error = toError(err)
      state.scaleOutBlocked = isDeterministicFailure(error)
      state.callbacks?.onCopyLoadFailure?.(reason, error, !state.scaleOutBlocked)
    })
    .finally(() => {
      if (state.copyTransitions.get(indexName) === run) state.copyTransitions.delete(indexName)
    })
  state.copyTransitions.set(indexName, run)
  await run
}

export async function scaleOutReadyIndexes(state: OrchestratorState): Promise<void> {
  if (!state.workersEnabled || state.scaleOutBlocked) return
  for (const indexName of state.indexRegistry.keys()) {
    if (!indexReadyForCopies(state, indexName)) continue
    const reason = copyThresholdReason(state, indexName)
    setTimeout(() => {
      void scaleOutIndex(state, indexName, reason)
    }, 0)
  }
}

export async function scaleOutBeforeBatch(
  state: OrchestratorState,
  indexName: string,
  incomingCount: number,
): Promise<void> {
  if (incomingCount <= 0) return
  const pending = state.copyTransitions.get(indexName)
  if (pending !== undefined) {
    await pending
    return
  }
  if (!indexReadyForCopies(state, indexName, incomingCount)) return
  await scaleOutIndex(state, indexName, copyThresholdReason(state, indexName))
}
