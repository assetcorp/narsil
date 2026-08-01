import { createWorkerFactory } from '#platform/worker-factory'
import { ErrorCodes, NarsilError } from '../errors'
import { type FanOutResult, kWayMerge } from '../partitioning/fan-out'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { GlobalStatistics } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { MemoryStats } from '../types/results'
import type { IndexConfig } from '../types/schema'
import type { QueryParams } from '../types/search'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import { createWorkerPool, type WorkerPool } from '../workers/pool'
import type { ExecutionPromoter } from '../workers/promoter'
import type { WorkerAction } from '../workers/protocol'
import { createRequestId } from '../workers/protocol'
import { transferIndexToPool } from './worker-resync'

export interface WorkerOrchestrator {
  checkPromotion(): Promise<void>
  replicateToWorkers(action: WorkerAction): Promise<void>
  searchViaWorker(indexName: string, params: QueryParams, globalStats?: GlobalStatistics): Promise<FanOutResult | null>
  isPromoted(): boolean
  desyncIndex(indexName: string): boolean
  resyncIndex(indexName: string, wasPromoted: boolean): Promise<void>
  getWorkerMemoryStats(): Promise<MemoryStats['workers']>
  shutdown(): Promise<void>
}

export interface WorkerOrchestratorCallbacks {
  onPromotion?: (workerCount: number, reason: string) => void
  onPromotionFailure?: (reason: string, error: Error, retryable: boolean) => void
  shouldDeferPromotion?: () => boolean
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isDeterministicFailure(error: Error): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.CONFIG_INVALID
}

function alreadyPresentOnWorker(reason: unknown): boolean {
  return reason instanceof NarsilError && reason.code === ErrorCodes.DOC_ALREADY_EXISTS
}

function workerIneligibility(
  indexName: string,
  config: IndexConfig,
  bootstrapModule: string | undefined,
): NarsilError | null {
  try {
    assertConfigReachesWorker(indexName, config, bootstrapModule)
    return null
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.CONFIG_INVALID) {
      return err
    }
    throw err
  }
}

function assertConfigReachesWorker(indexName: string, config: IndexConfig, bootstrapModule: string | undefined): void {
  if (config.tokenizer !== undefined && typeof config.tokenizer !== 'string') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" holds a tokenizer instance, and no worker thread can receive one. Register the tokenizer with registerTokenizer and name it in the index config`,
      { indexName },
    )
  }
  if (typeof config.stopWords === 'function') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" holds a stop word function, and no worker thread can receive one. Register the function with registerStopWords and name it in the index config`,
      { indexName },
    )
  }
  const language = config.language ?? 'english'
  if (language !== 'english' && bootstrapModule === undefined) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" uses language "${language}", which a worker thread registers only from a bootstrap module. Set workers.bootstrapModule to a module that registers it`,
      { indexName, language },
    )
  }
}

export function createWorkerOrchestrator(
  config: NarsilConfig | undefined,
  executor: Executor & DirectExecutorExtensions,
  promoter: ExecutionPromoter,
  indexRegistry: Map<
    string,
    { config: IndexConfig; language: LanguageModule; embeddingAdapter: EmbeddingAdapter | null }
  >,
  callbacks?: WorkerOrchestratorCallbacks,
): WorkerOrchestrator {
  let workerPool: WorkerPool | null = null
  let promotionInProgress = false
  let promotionBlocked = false
  let promotionRun: Promise<void> | null = null
  const promotionBuffer: WorkerAction[] = []
  const awaitingBufferedWrites = new Set<string>()
  const reportedIneligible = new Set<string>()
  const promotedIndexes = new Set<string>()
  const workersEnabled = config?.workers?.enabled === true
  const bootstrapModule = config?.workers?.bootstrapModule

  function reportIneligible(indexName: string, error: NarsilError): void {
    if (reportedIneligible.has(indexName)) return
    reportedIneligible.add(indexName)
    callbacks?.onPromotionFailure?.('index-excluded', error, false)
  }

  function collectEligibleIndexes(): Map<string, { documentCount: number }> {
    const eligible = new Map<string, { documentCount: number }>()
    for (const [name, entry] of indexRegistry) {
      const ineligibility = workerIneligibility(name, entry.config, bootstrapModule)
      if (ineligibility) {
        reportIneligible(name, ineligibility)
        continue
      }
      const mgr = executor.getManager(name)
      eligible.set(name, { documentCount: mgr?.countDocuments() ?? 0 })
    }
    return eligible
  }

  async function checkPromotion(): Promise<void> {
    if (!workersEnabled || promotionInProgress || promotionBlocked || workerPool) return
    if (callbacks?.shouldDeferPromotion?.()) return

    const indexMap = collectEligibleIndexes()
    if (indexMap.size === 0) return
    const result = promoter.check(indexMap)

    if (result.shouldPromote) {
      promotionInProgress = true
      setTimeout(() => {
        const run = runPromotion(result.reason).catch(err => {
          const error = toError(err)
          promotionBlocked = isDeterministicFailure(error)
          promotionInProgress = false
          callbacks?.onPromotionFailure?.(result.reason, error, !promotionBlocked)
        })
        promotionRun = run.then(() => {
          promotionRun = null
        })
      }, 0)
    }
  }

  async function runPromotion(reason: string): Promise<void> {
    try {
      const promotable: string[] = []
      for (const [name, entry] of indexRegistry) {
        const ineligibility = workerIneligibility(name, entry.config, bootstrapModule)
        if (ineligibility) {
          reportIneligible(name, ineligibility)
          continue
        }
        promotable.push(name)
      }
      if (promotable.length === 0) {
        promotionBuffer.length = 0
        return
      }

      const factory = await createWorkerFactory()
      const pool = createWorkerPool({
        count: config?.workers?.count,
        workerFactory: factory,
      })

      for (const name of promotable) {
        pool.addIndexToAll(name)
      }

      const allExecutors = pool.getAllExecutors()

      if (bootstrapModule !== undefined) {
        await Promise.all(
          allExecutors.map(workerExecutor =>
            workerExecutor.execute({
              type: 'bootstrap',
              moduleUrl: bootstrapModule,
              requestId: 'promote-bootstrap',
            }),
          ),
        )
      }

      for (const name of promotable) {
        const entry = indexRegistry.get(name)
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

        const manager = executor.getManager(name)
        if (manager) {
          for (let i = 0; i < manager.partitionCount; i++) {
            const serialized = manager.serializePartition(i)
            await Promise.all(
              allExecutors.map(workerExecutor =>
                workerExecutor.execute({
                  type: 'deserialize',
                  indexName: name,
                  partitionId: i,
                  data: serialized,
                  requestId: `promote-sync-${name}-${i}`,
                }),
              ),
            )
          }
        }
      }

      workerPool = pool
      for (const name of promotable) {
        promotedIndexes.add(name)
        awaitingBufferedWrites.add(name)
      }
      promoter.markPromoted()

      await drainPromotionBuffer()
      awaitingBufferedWrites.clear()

      callbacks?.onPromotion?.(pool.workerCount, reason)
    } catch (err) {
      promotionBuffer.length = 0
      throw err
    } finally {
      awaitingBufferedWrites.clear()
      promotionInProgress = false
    }
  }

  async function drainPromotionBuffer(): Promise<void> {
    while (promotionBuffer.length > 0) {
      const action = promotionBuffer.shift()
      if (action === undefined) return
      await dispatchToWorkers(action, true)
    }
  }

  async function replicateToWorkers(action: WorkerAction): Promise<void> {
    if (promotionInProgress) {
      promotionBuffer.push(action)
      return
    }
    await dispatchToWorkers(action, false)
  }

  async function dispatchToWorkers(action: WorkerAction, transferMayCover: boolean): Promise<void> {
    if (!workerPool) return

    if (action.type === 'createIndex') {
      const ineligibility = workerIneligibility(action.indexName, action.config, bootstrapModule)
      if (ineligibility) {
        reportIneligible(action.indexName, ineligibility)
        return
      }
      workerPool.addIndexToAll(action.indexName)
      promotedIndexes.add(action.indexName)
    } else if ('indexName' in action && !promotedIndexes.has(action.indexName)) {
      return
    }

    const allExecutors = workerPool.getAllExecutors()
    const results = await Promise.allSettled(allExecutors.map(workerExecutor => workerExecutor.execute(action)))

    for (const result of results) {
      if (result.status === 'rejected') {
        if (transferMayCover && alreadyPresentOnWorker(result.reason)) {
          continue
        }
        console.warn('Worker replication failed:', result.reason)
      }
    }
  }

  async function searchViaWorker(
    indexName: string,
    params: QueryParams,
    globalStats?: GlobalStatistics,
  ): Promise<FanOutResult | null> {
    if (!workerPool) return null
    if (!promotedIndexes.has(indexName)) return null
    if (awaitingBufferedWrites.has(indexName)) return null

    const manager = executor.getManager(indexName)
    if (!manager) return null

    const allExecutors = workerPool.getAllExecutors()
    const totalPartitions = manager.partitionCount
    const numWorkers = allExecutors.length

    if (numWorkers === 0) return null

    if (numWorkers === 1) {
      try {
        return await allExecutors[0].execute<FanOutResult>({
          type: 'query',
          indexName,
          params,
          requestId: createRequestId(),
          ...(globalStats !== undefined ? { globalStats } : {}),
        })
      } catch (err) {
        console.warn('Worker search failed, falling back to local:', err)
        return null
      }
    }

    try {
      const workerAssignments: number[][] = Array.from({ length: numWorkers }, () => [])
      for (let p = 0; p < totalPartitions; p++) {
        workerAssignments[p % numWorkers].push(p)
      }

      const results = await Promise.all(
        allExecutors.map((workerExecutor, idx) =>
          workerExecutor.execute<FanOutResult>({
            type: 'query',
            indexName,
            params,
            requestId: createRequestId(),
            partitionIds: workerAssignments[idx],
            ...(globalStats !== undefined ? { globalStats } : {}),
          }),
        ),
      )

      const allScored = results.map(r => r.scored)
      const merged = kWayMerge(allScored)
      let totalMatched = 0
      for (const r of results) {
        totalMatched += r.totalMatched
      }

      return { scored: merged, totalMatched }
    } catch (err) {
      console.warn('Parallel worker search failed, falling back to local:', err)
      return null
    }
  }

  function isPromoted(): boolean {
    return workerPool !== null
  }

  function desyncIndex(indexName: string): boolean {
    return promotedIndexes.delete(indexName)
  }

  async function resyncIndex(indexName: string, wasPromoted: boolean): Promise<void> {
    if (promotionRun) {
      await promotionRun.catch(() => undefined)
    }
    if (!workerPool) return
    if (!wasPromoted && !promotedIndexes.has(indexName)) return
    const entry = indexRegistry.get(indexName)
    if (!entry) return
    if (workerIneligibility(indexName, entry.config, bootstrapModule)) return
    const manager = executor.getManager(indexName)
    if (!manager) return

    promotedIndexes.delete(indexName)
    await transferIndexToPool(indexName, workerPool, entry.config, manager)
    promotedIndexes.add(indexName)
  }

  async function getWorkerMemoryStats(): Promise<MemoryStats['workers']> {
    if (!workerPool) return []
    const reports = await workerPool.getMemoryStats()
    return reports.map(s => ({
      workerId: s.workerId,
      heapUsed: s.heapUsed,
      heapTotal: s.heapTotal,
      external: s.external,
    }))
  }

  async function shutdown(): Promise<void> {
    if (workerPool) {
      await workerPool.shutdown()
      workerPool = null
      promotedIndexes.clear()
    }
  }

  return {
    checkPromotion,
    replicateToWorkers,
    searchViaWorker,
    isPromoted,
    desyncIndex,
    resyncIndex,
    getWorkerMemoryStats,
    shutdown,
  }
}
