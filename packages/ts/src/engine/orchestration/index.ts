import { ErrorCodes, NarsilError } from '../../errors'
import type { FanOutResult } from '../../partitioning/fan-out'
import { detectRuntime } from '../../runtime/detect'
import type { NarsilConfig } from '../../types/config'
import type { GlobalStatistics } from '../../types/internal'
import type { MemoryStats, WorkerCopyReport } from '../../types/results'
import type { QueryParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import { resolveWorkerCount, splitWorkerBudget } from '../../workers/pool'
import type { WorkerAction } from '../../workers/protocol'
import { transferIndexToPool } from '../worker-resync'
import { awaitCompactions, cancelIdleMerge, maybeCompactSegments, scheduleIdleMerge } from './compaction'
import { DEFAULT_COPY_IDLE_TIMEOUT_MS, isIndexBusy, noteAccess, startIdleSweep, stopIdleSweep } from './idle'
import { flushGrownTails } from './live-tail'
import { cancelRepair, POOL_RESTART_DELAY_MS } from './repair'
import { awaitReplicationIdle, replicateToWorkers } from './replication'
import {
  copyThresholdReason,
  indexReadyForCopies,
  scaleOutBeforeBatch,
  scaleOutIndex,
  scaleOutReadyIndexes,
} from './scale-out'
import { searchViaWorker } from './search'
import { type BuiltSegment, buildSegments, type SegmentBuildRequest, segmentBuildConcurrency } from './segments'
import type { IndexRegistry, OrchestratorState, WorkerOrchestrator, WorkerOrchestratorCallbacks } from './types'

export type { WorkerOrchestrator, WorkerOrchestratorCallbacks } from './types'

export const DEFAULT_COPY_THRESHOLD = 1_000

export function workersEnabledByDefault(): boolean {
  return detectRuntime().runtime !== 'browser'
}

function copyIdleTimeoutBeforeClose(closeAfterMs: number | undefined): number {
  return closeAfterMs === undefined
    ? DEFAULT_COPY_IDLE_TIMEOUT_MS
    : Math.min(DEFAULT_COPY_IDLE_TIMEOUT_MS, closeAfterMs)
}

export function createWorkerOrchestrator(
  config: NarsilConfig | undefined,
  executor: Executor & DirectExecutorExtensions,
  indexRegistry: IndexRegistry,
  callbacks?: WorkerOrchestratorCallbacks,
): WorkerOrchestrator {
  const state: OrchestratorState = {
    config,
    executor,
    indexRegistry,
    callbacks,
    workersEnabled: config?.workers?.enabled ?? workersEnabledByDefault(),
    keywordWorkerCount: splitWorkerBudget(resolveWorkerCount(config?.workers?.count)).keyword,
    copyThreshold: config?.workers?.promotionThreshold ?? DEFAULT_COPY_THRESHOLD,
    copyIdleTimeoutMs: config?.workers?.idleTimeoutMs ?? copyIdleTimeoutBeforeClose(config?.lifecycle?.idleTimeoutMs),
    bootstrapModule: config?.workers?.bootstrapModule,
    reportedIneligible: new Set(),
    scaledOutIndexes: new Set(),
    desyncedIndexes: new Set(),
    copyLoadBuffers: new Map(),
    copyTransitions: new Map(),
    droppedCopies: new Map(),
    lastAccessAt: new Map(),
    copyReloadCounts: new Map(),
    replicationQueues: new Map(),
    segmentLedger: new Map(),
    compactionsInFlight: new Map(),
    idleMergeTimers: new Map(),
    workerPool: null,
    poolStart: null,
    poolRetryAt: 0,
    poolRetryDelayMs: POOL_RESTART_DELAY_MS,
    poolRepair: null,
    mainCopyTurnTaken: false,
    repairTimer: null,
    scaleOutBlocked: false,
    idleSweep: null,
  }
  startIdleSweep(state)

  async function resyncIndex(indexName: string, wasScaledOut: boolean): Promise<void> {
    state.desyncedIndexes.delete(indexName)
    if (!wasScaledOut) return
    await scaleOutIndex(state, indexName, copyThresholdReason(state, indexName))
  }

  async function openIndex(indexName: string): Promise<void> {
    state.droppedCopies.delete(indexName)
    if (!indexReadyForCopies(state, indexName)) return
    await scaleOutIndex(state, indexName, copyThresholdReason(state, indexName))
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

  function workerCopies(): WorkerCopyReport[] {
    const reports: WorkerCopyReport[] = []
    for (const indexName of indexRegistry.keys()) {
      reports.push({
        indexName,
        scaledOut: state.scaledOutIndexes.has(indexName),
        reloadCount: state.copyReloadCounts.get(indexName) ?? 0,
      })
    }
    return reports
  }

  async function shutdown(): Promise<void> {
    stopIdleSweep(state)
    cancelRepair(state)
    for (const indexName of [...state.idleMergeTimers.keys()]) cancelIdleMerge(state, indexName)
    await Promise.allSettled([...state.copyTransitions.values()].map(transition => transition.done))
    if (state.poolRepair !== null) await state.poolRepair
    if (state.poolStart !== null) await state.poolStart.catch(() => undefined)
    if (state.workerPool) {
      await awaitCompactions(state)
      await awaitReplicationIdle(state)
      await state.workerPool.shutdown()
      state.workerPool = null
      state.scaledOutIndexes.clear()
      state.replicationQueues.clear()
      state.segmentLedger.clear()
    }
  }

  async function restoreAfterFailedClose(indexName: string, failure: PromiseRejectedResult): Promise<never> {
    const pool = state.workerPool
    const entry = indexRegistry.get(indexName)
    const manager = executor.getManager(indexName)
    if (pool !== null && entry !== undefined && manager !== undefined) {
      try {
        await transferIndexToPool(indexName, pool, entry.config, manager)
        state.scaledOutIndexes.add(indexName)
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

  async function closeIndex(indexName: string): Promise<void> {
    if (state.poolRepair !== null) await state.poolRepair
    const transition = state.copyTransitions.get(indexName)
    if (transition !== undefined) await transition.done
    await awaitReplicationIdle(state, indexName)
    await awaitCompactions(state)
    cancelIdleMerge(state, indexName)
    const pool = state.workerPool
    if (pool !== null && state.scaledOutIndexes.has(indexName)) {
      state.scaledOutIndexes.delete(indexName)
      const outcomes = await Promise.allSettled(
        pool
          .executorsHolding(indexName)
          .map(worker => worker.execute({ type: 'dropIndex', indexName, requestId: `close-${indexName}` })),
      )
      const failure = outcomes.find(outcome => outcome.status === 'rejected')
      if (failure?.status === 'rejected') await restoreAfterFailedClose(indexName, failure)
      pool.removeIndex(indexName)
    }
    state.droppedCopies.delete(indexName)
    state.desyncedIndexes.delete(indexName)
    state.lastAccessAt.delete(indexName)
    state.replicationQueues.delete(indexName)
    state.segmentLedger.delete(indexName)
  }

  async function replicate(action: WorkerAction): Promise<void> {
    await replicateToWorkers(state, action)
    if (!('indexName' in action)) return
    if (action.type === 'attachSegments') maybeCompactSegments(state, action.indexName)
    if (action.type === 'insert' || action.type === 'update') flushGrownTails(state, action.indexName)
    if (state.scaledOutIndexes.has(action.indexName) || state.copyLoadBuffers.has(action.indexName)) {
      scheduleIdleMerge(state, action.indexName)
    }
  }

  return {
    scaleOutReadyIndexes: (): Promise<void> => scaleOutReadyIndexes(state),
    scaleOutBeforeBatch: (indexName: string, incomingCount: number): Promise<void> =>
      scaleOutBeforeBatch(state, indexName, incomingCount),
    replicateToWorkers: replicate,
    awaitReplication: (indexName?: string): Promise<void> => awaitReplicationIdle(state, indexName),
    awaitCompactions: (): Promise<void> => awaitCompactions(state),
    openIndex,
    closeIndex,
    isIndexBusy: (indexName: string): boolean => isIndexBusy(state, indexName),
    buildSegments: (requests: SegmentBuildRequest[]): Promise<BuiltSegment[] | null> => buildSegments(state, requests),
    segmentBuildConcurrency: (indexName: string): number => segmentBuildConcurrency(state, indexName),
    searchViaWorker: (
      indexName: string,
      params: QueryParams,
      globalStats?: GlobalStatistics,
      partitionIds?: number[],
    ): Promise<FanOutResult | null> => searchViaWorker(state, indexName, params, globalStats, partitionIds),
    hasWorkerPool: (): boolean => state.workerPool !== null,
    desyncIndex: (indexName: string): boolean => {
      state.desyncedIndexes.add(indexName)
      return state.scaledOutIndexes.delete(indexName)
    },
    resyncIndex,
    noteAccess: (indexName: string): void => noteAccess(state, indexName),
    workerCopies,
    getWorkerMemoryStats,
    shutdown,
  }
}
