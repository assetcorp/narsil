import type { FanOutResult } from '../../partitioning/fan-out'
import type { NarsilConfig } from '../../types/config'
import type { GlobalStatistics } from '../../types/internal'
import type { MemoryStats } from '../../types/results'
import type { QueryParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { ExecutionPromoter } from '../../workers/promoter'
import type { WorkerAction } from '../../workers/protocol'
import { transferIndexToPool } from '../worker-resync'
import { workerIneligibility } from './eligibility'
import { checkPromotion } from './promotion'
import { replicateToWorkers } from './replication'
import { searchViaWorker } from './search'
import type { IndexRegistry, OrchestratorState, WorkerOrchestrator, WorkerOrchestratorCallbacks } from './types'

export type { WorkerOrchestrator, WorkerOrchestratorCallbacks } from './types'

export function createWorkerOrchestrator(
  config: NarsilConfig | undefined,
  executor: Executor & DirectExecutorExtensions,
  promoter: ExecutionPromoter,
  indexRegistry: IndexRegistry,
  callbacks?: WorkerOrchestratorCallbacks,
): WorkerOrchestrator {
  const state: OrchestratorState = {
    config,
    executor,
    promoter,
    indexRegistry,
    callbacks,
    workersEnabled: config?.workers?.enabled === true,
    bootstrapModule: config?.workers?.bootstrapModule,
    promotionBuffer: [],
    awaitingBufferedWrites: new Set(),
    reportedIneligible: new Set(),
    promotedIndexes: new Set(),
    workerPool: null,
    promotionInProgress: false,
    promotionBlocked: false,
    promotionRun: null,
  }

  async function resyncIndex(indexName: string, wasPromoted: boolean): Promise<void> {
    if (state.promotionRun) {
      await state.promotionRun.catch(() => undefined)
    }
    const pool = state.workerPool
    if (!pool) return
    if (!wasPromoted && !state.promotedIndexes.has(indexName)) return
    const entry = indexRegistry.get(indexName)
    if (!entry) return
    if (workerIneligibility(indexName, entry.config, state.bootstrapModule)) return
    const manager = executor.getManager(indexName)
    if (!manager) return

    state.promotedIndexes.delete(indexName)
    await transferIndexToPool(indexName, pool, entry.config, manager)
    state.promotedIndexes.add(indexName)
  }

  async function getWorkerMemoryStats(): Promise<MemoryStats['workers']> {
    if (!state.workerPool) return []
    const reports = await state.workerPool.getMemoryStats()
    return reports.map(report => ({
      workerId: report.workerId,
      heapUsed: report.heapUsed,
      heapTotal: report.heapTotal,
      external: report.external,
    }))
  }

  async function shutdown(): Promise<void> {
    if (state.workerPool) {
      await state.workerPool.shutdown()
      state.workerPool = null
      state.promotedIndexes.clear()
    }
  }

  return {
    checkPromotion: (): Promise<void> => checkPromotion(state),
    replicateToWorkers: (action: WorkerAction): Promise<void> => replicateToWorkers(state, action),
    searchViaWorker: (
      indexName: string,
      params: QueryParams,
      globalStats?: GlobalStatistics,
    ): Promise<FanOutResult | null> => searchViaWorker(state, indexName, params, globalStats),
    isPromoted: (): boolean => state.workerPool !== null,
    desyncIndex: (indexName: string): boolean => state.promotedIndexes.delete(indexName),
    resyncIndex,
    getWorkerMemoryStats,
    shutdown,
  }
}
