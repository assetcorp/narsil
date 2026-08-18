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
import { awaitCompactions, maybeCompactSegments } from './compaction'
import { workerIneligibility } from './eligibility'
import { checkPromotion, promoteBeforeBatch } from './promotion'
import { awaitReplicationIdle, replicateToWorkers } from './replication'
import { searchViaWorker } from './search'
import { type BuiltSegment, buildSegments, type SegmentBuildRequest, segmentBuildConcurrency } from './segments'
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
    replicationQueues: new Map(),
    segmentLedger: new Map(),
    compactionsInFlight: new Map(),
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
    await awaitReplicationIdle(state, indexName)
    state.segmentLedger.delete(indexName)
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
      await awaitCompactions(state)
      await awaitReplicationIdle(state)
      await state.workerPool.shutdown()
      state.workerPool = null
      state.promotedIndexes.clear()
      state.replicationQueues.clear()
      state.segmentLedger.clear()
    }
  }

  async function replicate(action: WorkerAction): Promise<void> {
    await replicateToWorkers(state, action)
    if (action.type === 'attachSegments') {
      maybeCompactSegments(state, action.indexName)
    }
  }

  return {
    checkPromotion: (): Promise<void> => checkPromotion(state),
    promoteBeforeBatch: (indexName: string, incomingCount: number): Promise<void> =>
      promoteBeforeBatch(state, indexName, incomingCount),
    replicateToWorkers: replicate,
    awaitReplication: (indexName?: string): Promise<void> => awaitReplicationIdle(state, indexName),
    awaitCompactions: (): Promise<void> => awaitCompactions(state),
    buildSegments: (requests: SegmentBuildRequest[]): Promise<BuiltSegment[] | null> => buildSegments(state, requests),
    segmentBuildConcurrency: (indexName: string): number => segmentBuildConcurrency(state, indexName),
    searchViaWorker: (
      indexName: string,
      params: QueryParams,
      globalStats?: GlobalStatistics,
      partitionIds?: number[],
    ): Promise<FanOutResult | null> => searchViaWorker(state, indexName, params, globalStats, partitionIds),
    isPromoted: (): boolean => state.workerPool !== null,
    desyncIndex: (indexName: string): boolean => state.promotedIndexes.delete(indexName),
    resyncIndex,
    getWorkerMemoryStats,
    shutdown,
  }
}
