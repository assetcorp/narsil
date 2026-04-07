import { createWorkerFactory } from '#platform/worker-factory'
import { type FanOutResult, kWayMerge } from '../partitioning/fan-out'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
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

export interface WorkerOrchestrator {
  checkPromotion(): Promise<void>
  replicateToWorkers(action: WorkerAction): Promise<void>
  searchViaWorker(indexName: string, params: QueryParams): Promise<FanOutResult | null>
  isPromoted(): boolean
  getMemoryStats(): MemoryStats
  shutdown(): Promise<void>
}

export interface WorkerOrchestratorCallbacks {
  onPromotion?: (workerCount: number, reason: string) => void
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
  const promotionBuffer: WorkerAction[] = []
  const workersEnabled = config?.workers?.enabled === true

  async function checkPromotion(): Promise<void> {
    if (!workersEnabled || promotionInProgress || workerPool) return

    const indexMap = new Map<string, { documentCount: number }>()
    for (const [name] of indexRegistry) {
      const mgr = executor.getManager(name)
      indexMap.set(name, { documentCount: mgr?.countDocuments() ?? 0 })
    }
    const result = promoter.check(indexMap)

    if (result.shouldPromote) {
      promotionInProgress = true
      setTimeout(() => {
        runPromotion(result.reason).catch(err => {
          console.warn('Worker promotion failed:', err)
          promotionInProgress = false
        })
      }, 0)
    }
  }

  async function runPromotion(reason: string): Promise<void> {
    try {
      const factory = await createWorkerFactory()
      const pool = createWorkerPool({
        count: config?.workers?.count,
        workerFactory: factory,
      })

      for (const [name] of indexRegistry) {
        pool.addIndexToAll(name)
      }

      const allExecutors = pool.getAllExecutors()

      for (const [name, entry] of indexRegistry) {
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
      promoter.markPromoted()

      if (promotionBuffer.length > 0) {
        const buffered = [...promotionBuffer]
        promotionBuffer.length = 0
        for (const action of buffered) {
          await replicateToWorkers(action)
        }
      }

      callbacks?.onPromotion?.(pool.workerCount, reason)
    } catch (err) {
      promotionBuffer.length = 0
      throw err
    } finally {
      promotionInProgress = false
    }
  }

  async function replicateToWorkers(action: WorkerAction): Promise<void> {
    if (promotionInProgress) {
      promotionBuffer.push(action)
      return
    }
    if (!workerPool) return

    const allExecutors = workerPool.getAllExecutors()
    const results = await Promise.allSettled(allExecutors.map(workerExecutor => workerExecutor.execute(action)))

    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('Worker replication failed:', result.reason)
      }
    }
  }

  async function searchViaWorker(indexName: string, params: QueryParams): Promise<FanOutResult | null> {
    if (!workerPool) return null

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

  function getMemoryStats(): MemoryStats {
    const workers = workerPool
      ? workerPool.getMemoryStats().map(s => ({
          workerId: s.workerId,
          heapUsed: s.heapUsed,
          heapTotal: s.heapTotal,
          external: s.external,
        }))
      : []
    const totalBytes = workers.reduce((sum, w) => sum + w.heapUsed, 0)
    return { totalBytes, workers }
  }

  async function shutdown(): Promise<void> {
    if (workerPool) {
      await workerPool.shutdown()
      workerPool = null
    }
  }

  return { checkPromotion, replicateToWorkers, searchViaWorker, isPromoted, getMemoryStats, shutdown }
}
