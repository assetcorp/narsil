import type { NarsilConfig } from '../types/config'
import type { LanguageModule } from '../types/language'
import type { MemoryStats } from '../types/results'
import type { IndexConfig } from '../types/schema'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import { createWorkerFactory } from '../workers/factory'
import { createWorkerPool, type WorkerPool } from '../workers/pool'
import type { ExecutionPromoter } from '../workers/promoter'
import type { WorkerAction } from '../workers/protocol'

export interface WorkerOrchestrator {
  checkPromotion(): void
  replicateToWorkers(action: WorkerAction): Promise<void>
  getMemoryStats(): MemoryStats
  shutdown(): Promise<void>
}

export function createWorkerOrchestrator(
  config: NarsilConfig | undefined,
  executor: Executor & DirectExecutorExtensions,
  promoter: ExecutionPromoter,
  indexRegistry: Map<string, { config: IndexConfig; language: LanguageModule }>,
): WorkerOrchestrator {
  let workerPool: WorkerPool | null = null
  let promotionInProgress = false
  const workersEnabled = config?.workers?.enabled === true

  function checkPromotion(): void {
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
        runPromotion().catch(err => {
          console.warn('Worker promotion failed:', err)
          promotionInProgress = false
        })
      }, 0)
    }
  }

  async function runPromotion(): Promise<void> {
    try {
      const factory = await createWorkerFactory()
      const pool = createWorkerPool({
        count: config?.workers?.count,
        workerFactory: factory,
      })

      for (const [name, entry] of indexRegistry) {
        pool.addIndex(name)
        const workerExecutor = pool.getExecutor(name)
        await workerExecutor.execute({
          type: 'createIndex',
          indexName: name,
          config: entry.config,
          requestId: `promote-create-${name}`,
        })

        const manager = executor.getManager(name)
        if (manager) {
          for (let i = 0; i < manager.partitionCount; i++) {
            const serialized = manager.serializePartition(i)
            await workerExecutor.execute({
              type: 'deserialize',
              indexName: name,
              partitionId: i,
              data: serialized,
              requestId: `promote-sync-${name}-${i}`,
            })
          }
        }
      }

      workerPool = pool
      promoter.markPromoted()
    } finally {
      promotionInProgress = false
    }
  }

  async function replicateToWorkers(action: WorkerAction): Promise<void> {
    if (!workerPool) return

    const indexName = 'indexName' in action ? (action as { indexName: string }).indexName : null
    if (!indexName) return

    try {
      const workerExecutor = workerPool.getExecutor(indexName)
      await workerExecutor.execute(action)
    } catch (err) {
      console.warn('Worker replication failed:', err)
    }
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

  return { checkPromotion, replicateToWorkers, getMemoryStats, shutdown }
}
