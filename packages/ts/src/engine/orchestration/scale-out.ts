import { createWorkerFactory } from '#platform/worker-factory'
import { createWorkerPool, type WorkerPool } from '../../workers/pool'
import type { WorkerAction } from '../../workers/protocol'
import { transferIndexToPool } from '../worker-resync'
import { scheduleIdleMerge } from './compaction'
import {
  eligibleIndexNames,
  isDeterministicFailure,
  reportIneligible,
  toError,
  workerIneligibility,
} from './eligibility'
import { deferPoolRestart, handleWorkerCrash, POOL_RESTART_DELAY_MS } from './repair'
import { enqueueReplication } from './replication'
import type { CopyTransition, OrchestratorState } from './types'

export const COPY_RELOAD_REASON = 'A request arrived after an idle spell dropped the worker copies'

export function copiesAllowed(state: OrchestratorState): boolean {
  if (!state.workersEnabled || state.scaleOutBlocked) return false
  return state.workerPool !== null || Date.now() >= state.poolRetryAt
}

async function startPool(state: OrchestratorState): Promise<WorkerPool> {
  eligibleIndexNames(state)
  const factory = await createWorkerFactory()
  let started: WorkerPool | null = null
  const pool = createWorkerPool({
    count: state.keywordWorkerCount,
    workerFactory: factory,
    onWorkerCrash(workerId, indexNames, error) {
      if (started !== null) handleWorkerCrash(state, started, workerId, indexNames, error)
    },
  })
  started = pool
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
        deferPoolRestart(state)
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
  if (!copiesAllowed(state)) return false
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
  const dropReason = state.droppedCopies.get(indexName)
  const reload = state.droppedCopies.delete(indexName)
  const buffered: WorkerAction[] = []
  state.copyLoadBuffers.set(indexName, buffered)
  try {
    await transferIndexToPool(indexName, pool, entry.config, manager)
    state.scaledOutIndexes.add(indexName)
    state.lastAccessAt.set(indexName, Date.now())
    state.poolRetryDelayMs = POOL_RESTART_DELAY_MS
    for (const action of buffered) enqueueReplication(state, indexName, action)
  } catch (err) {
    if (dropReason !== undefined) state.droppedCopies.set(indexName, dropReason)
    throw err
  } finally {
    state.copyLoadBuffers.delete(indexName)
  }
  if (reload) state.copyReloadCounts.set(indexName, (state.copyReloadCounts.get(indexName) ?? 0) + 1)
  scheduleIdleMerge(state, indexName)
  state.callbacks?.onCopiesLoaded?.(pool.workerCount, reason)
}

async function loadAfter(
  previous: CopyTransition | undefined,
  state: OrchestratorState,
  indexName: string,
  reason: string,
): Promise<void> {
  if (previous !== undefined) await previous.done
  if (state.poolRepair !== null) await state.poolRepair
  if (!copiesAllowed(state)) return
  if (state.scaledOutIndexes.has(indexName) || state.desyncedIndexes.has(indexName)) return
  await loadCopies(state, indexName, reason)
}

export function scaleOutIndex(state: OrchestratorState, indexName: string, reason: string): Promise<void> {
  const previous = state.copyTransitions.get(indexName)
  if (previous !== undefined && previous.kind !== 'drop') return previous.done
  const kind = state.droppedCopies.has(indexName) ? 'reload' : 'load'
  const done = loadAfter(previous, state, indexName, reason)
    .catch(err => {
      const error = toError(err)
      state.scaleOutBlocked = isDeterministicFailure(error)
      state.callbacks?.onCopyLoadFailure?.(reason, error, !state.scaleOutBlocked)
    })
    .finally(() => {
      if (state.copyTransitions.get(indexName)?.done === done) state.copyTransitions.delete(indexName)
    })
  state.copyTransitions.set(indexName, { kind, done })
  return done
}

export async function scaleOutReadyIndexes(state: OrchestratorState): Promise<void> {
  if (!copiesAllowed(state)) return
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
    if (pending.kind === 'load') await pending.done
    return
  }
  if (!indexReadyForCopies(state, indexName, incomingCount)) return
  await scaleOutIndex(state, indexName, copyThresholdReason(state, indexName))
}
