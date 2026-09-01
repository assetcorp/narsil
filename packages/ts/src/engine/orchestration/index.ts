import { ErrorCodes, NarsilError } from '../../errors'
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

  async function awaitPromotionIdle(): Promise<void> {
    while (state.promotionInProgress) {
      const run = state.promotionRun
      if (run !== null) {
        await run
      } else {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
  }

  async function closeIndex(indexName: string): Promise<void> {
    await awaitPromotionIdle()
    await awaitReplicationIdle(state, indexName)
    await awaitCompactions(state)
    const pool = state.workerPool
    if (pool !== null && state.promotedIndexes.has(indexName)) {
      const outcomes = await Promise.allSettled(
        pool
          .getAllExecutors()
          .map(worker => worker.execute({ type: 'dropIndex', indexName, requestId: `close-${indexName}` })),
      )
      const failure = outcomes.find(outcome => outcome.status === 'rejected')
      if (failure?.status === 'rejected') {
        const entry = indexRegistry.get(indexName)
        const manager = executor.getManager(indexName)
        if (entry !== undefined && manager !== undefined) {
          try {
            await transferIndexToPool(indexName, pool, entry.config, manager)
          } catch (repairError) {
            throw new NarsilError(
              ErrorCodes.WORKER_CRASHED,
              `Worker copies for index "${indexName}" could not be restored after close failed`,
              {
                indexName,
                closeError: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
                repairError: repairError instanceof Error ? repairError.message : String(repairError),
              },
            )
          }
        }
        if (failure.reason instanceof NarsilError) throw failure.reason
        throw new NarsilError(ErrorCodes.WORKER_CRASHED, `A worker could not close index "${indexName}"`, {
          indexName,
          cause: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        })
      }
      pool.removeIndex(indexName)
    }
    state.promotedIndexes.delete(indexName)
    state.replicationQueues.delete(indexName)
    state.segmentLedger.delete(indexName)
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
    openIndex: (indexName: string): Promise<void> => resyncIndex(indexName, true),
    closeIndex,
    isIndexBusy: (indexName: string): boolean =>
      state.promotionInProgress || state.replicationQueues.has(indexName) || state.compactionsInFlight.has(indexName),
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
