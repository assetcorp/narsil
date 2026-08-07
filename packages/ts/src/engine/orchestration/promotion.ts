import { createWorkerFactory } from '#platform/worker-factory'
import { createWorkerPool, type WorkerPool } from '../../workers/pool'
import { collectEligibleIndexes, eligibleIndexNames, isDeterministicFailure, toError } from './eligibility'
import { drainPromotionBuffer } from './replication'
import type { OrchestratorState } from './types'

async function bootstrapWorkers(state: OrchestratorState, pool: WorkerPool, indexNames: string[]): Promise<void> {
  const allExecutors = pool.getAllExecutors()

  if (state.bootstrapModule !== undefined) {
    const moduleUrl = state.bootstrapModule
    await Promise.all(
      allExecutors.map(workerExecutor =>
        workerExecutor.execute({ type: 'bootstrap', moduleUrl, requestId: 'promote-bootstrap' }),
      ),
    )
  }

  for (const name of indexNames) {
    const entry = state.indexRegistry.get(name)
    if (!entry) continue
    await Promise.all(
      allExecutors.map(workerExecutor =>
        workerExecutor.execute({
          type: 'createIndex',
          indexName: name,
          config: entry.config,
          requestId: `promote-create-${name}`,
        }),
      ),
    )

    const manager = state.executor.getManager(name)
    if (!manager) continue
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
      const serialized = manager.serializePartition(partitionId)
      await Promise.all(
        allExecutors.map(workerExecutor =>
          workerExecutor.execute({
            type: 'deserialize',
            indexName: name,
            partitionId,
            data: serialized,
            requestId: `promote-sync-${name}-${partitionId}`,
          }),
        ),
      )
    }
  }
}

async function runPromotion(state: OrchestratorState, reason: string): Promise<void> {
  try {
    const promotable = eligibleIndexNames(state)
    if (promotable.length === 0) {
      state.promotionBuffer.length = 0
      return
    }

    const factory = await createWorkerFactory()
    const pool = createWorkerPool({ count: state.config?.workers?.count, workerFactory: factory })

    for (const name of promotable) {
      pool.addIndexToAll(name)
    }

    await bootstrapWorkers(state, pool, promotable)

    state.workerPool = pool
    for (const name of promotable) {
      state.promotedIndexes.add(name)
      state.awaitingBufferedWrites.add(name)
    }
    state.promoter.markPromoted()

    await drainPromotionBuffer(state)
    state.awaitingBufferedWrites.clear()

    state.callbacks?.onPromotion?.(pool.workerCount, reason)
  } catch (err) {
    state.promotionBuffer.length = 0
    throw err
  } finally {
    state.awaitingBufferedWrites.clear()
    state.promotionInProgress = false
  }
}

export async function checkPromotion(state: OrchestratorState): Promise<void> {
  if (!state.workersEnabled || state.promotionInProgress || state.promotionBlocked || state.workerPool) return
  if (state.callbacks?.shouldDeferPromotion?.()) return

  const indexMap = collectEligibleIndexes(state)
  if (indexMap.size === 0) return
  const result = state.promoter.check(indexMap)
  if (!result.shouldPromote) return

  state.promotionInProgress = true
  setTimeout(() => {
    const run = runPromotion(state, result.reason).catch(err => {
      const error = toError(err)
      state.promotionBlocked = isDeterministicFailure(error)
      state.promotionInProgress = false
      state.callbacks?.onPromotionFailure?.(result.reason, error, !state.promotionBlocked)
    })
    state.promotionRun = run.then(() => {
      state.promotionRun = null
    })
  }, 0)
}
