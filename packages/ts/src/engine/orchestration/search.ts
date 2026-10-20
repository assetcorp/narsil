import { widestPatternSplit } from '../../core/pattern-index/matcher-budget'
import { largestPatternFootprint } from '../../core/pattern-index/query-positions'
import type { PatternWorkFork, SearchPatternWork, SharedPatternWork } from '../../core/pattern-index/work-meter'
import { ErrorCodes, NarsilError } from '../../errors'
import { type FanOutResult, kWayMerge } from '../../partitioning/fan-out'
import type { PartitionManager } from '../../partitioning/manager'
import { mergeFacets, oversampledFacetConfig } from '../../search/facets'
import type { GlobalStatistics } from '../../types/internal'
import type { FacetResult } from '../../types/results'
import type { FacetConfig, QueryParams } from '../../types/search'
import type { WorkerLease, WorkerPool } from '../../workers/pool'
import { createRequestId } from '../../workers/protocol'
import { MAIN_COPY_LONE_QUERY_DOCUMENTS } from './constants'
import { afterCurrentTurn } from './turn'
import type { OrchestratorState } from './types'

function partitionsPerLease(scope: number[], leaseCount: number): number[][] {
  const assignments: number[][] = Array.from({ length: leaseCount }, () => [])
  for (let at = 0; at < scope.length; at++) {
    assignments[at % leaseCount].push(scope[at])
  }
  return assignments
}

function mergeWorkerResults(results: FanOutResult[], facetConfig: FacetConfig | undefined): FanOutResult {
  const merged = kWayMerge(results.map(result => result.scored))
  let totalMatched = 0
  let patternWorkSpent = 0
  const workerFacets: Array<Record<string, FacetResult>> = []
  for (const result of results) {
    totalMatched += result.totalMatched
    patternWorkSpent += result.patternWorkSpent ?? 0
    if (result.facets !== undefined) workerFacets.push(result.facets)
  }
  return {
    scored: merged,
    totalMatched,
    facets: facetConfig !== undefined && workerFacets.length > 0 ? mergeFacets(workerFacets, facetConfig) : undefined,
    patternWorkSpent,
  }
}

function scoresPerPartition(
  state: OrchestratorState,
  indexName: string,
  params: QueryParams,
  globalStats: GlobalStatistics | undefined,
): boolean {
  const mode = params.scoring ?? state.indexRegistry.get(indexName)?.config.defaultScoring ?? 'local'
  if (mode === 'local') return true
  return mode === 'broadcast' && globalStats !== undefined
}

function queryAction(
  indexName: string,
  params: QueryParams,
  globalStats: GlobalStatistics | undefined,
  partitionIds: number[] | undefined,
  patternWork: SharedPatternWork,
) {
  return {
    type: 'query' as const,
    indexName,
    params,
    requestId: createRequestId(),
    patternWork,
    ...(partitionIds !== undefined ? { partitionIds } : {}),
    ...(globalStats !== undefined ? { globalStats } : {}),
  }
}

async function runSplit(
  leases: WorkerLease[],
  scope: number[],
  indexName: string,
  params: QueryParams,
  globalStats: GlobalStatistics | undefined,
  patternWork: SharedPatternWork,
): Promise<FanOutResult> {
  const assignments = partitionsPerLease(scope, leases.length)
  const workerParams =
    params.facets !== undefined ? { ...params, facets: oversampledFacetConfig(params.facets) } : params
  const outcomes = await Promise.allSettled(
    assignments.map((partitionIds, at) =>
      leases[at].executor
        .execute<FanOutResult>(queryAction(indexName, workerParams, globalStats, partitionIds, patternWork))
        .finally(() => leases[at].release()),
    ),
  )
  const results: FanOutResult[] = []
  const failures: unknown[] = []
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') results.push(outcome.value)
    else failures.push(outcome.reason)
  }
  if (failures.length > 0) throw failures.find(isWorkCapError) ?? failures[0]
  return mergeWorkerResults(results, params.facets)
}

function isWorkCapError(err: unknown): boolean {
  return err instanceof NarsilError && err.code === ErrorCodes.SEARCH_WORK_CAP_EXCEEDED
}

function patternSplitWidth(state: OrchestratorState, indexName: string, params: QueryParams): number {
  const schema = state.indexRegistry.get(indexName)?.config.schema
  if (schema === undefined) return Number.POSITIVE_INFINITY
  const largest = largestPatternFootprint(params.filters, schema)
  if (largest === null) return Number.POSITIVE_INFINITY
  if (typeof SharedArrayBuffer !== 'function') return 1
  return widestPatternSplit(largest)
}

function takeMainCopyTurn(state: OrchestratorState): boolean {
  if (state.mainCopyQueries === 'none' || state.mainCopyTurnTaken) return false
  state.mainCopyTurnTaken = true
  afterCurrentTurn(() => {
    state.mainCopyTurnTaken = false
  })
  return true
}

function answersFasterOnMainCopy(state: OrchestratorState, pool: WorkerPool, manager: PartitionManager): boolean {
  if (pool.queriesInFlight() > 0) return false
  if (manager.countDocuments() > MAIN_COPY_LONE_QUERY_DOCUMENTS) return false
  return takeMainCopyTurn(state)
}

export async function searchViaWorker(
  state: OrchestratorState,
  indexName: string,
  params: QueryParams,
  globalStats: GlobalStatistics | undefined,
  partitionIds: number[] | undefined,
  patternWork: SearchPatternWork,
): Promise<FanOutResult | null> {
  const pool = state.workerPool
  if (!pool) return null
  if (!state.scaledOutIndexes.has(indexName) || state.copyLoadBuffers.has(indexName)) return null

  const manager = state.executor.getManager(indexName)
  if (!manager) return null

  if (answersFasterOnMainCopy(state, pool, manager)) return null

  const scope = partitionIds ?? Array.from({ length: manager.partitionCount }, (_, partitionId) => partitionId)
  const idle = pool.leaseIdle(Math.min(scope.length, patternSplitWidth(state, indexName, params)))
  const leases: WorkerLease[] = []
  let fork: PatternWorkFork | null = null
  try {
    if (idle.length >= 2 && scoresPerPartition(state, indexName, params, globalStats)) {
      leases.push(...idle)
      fork = patternWork.fork(leases.length)
      const merged = await runSplit(leases, scope, indexName, params, globalStats, fork.shared)
      fork.settle(merged.patternWorkSpent ?? 0)
      return merged
    }
    for (const lease of idle.slice(1)) lease.release()
    const lease = idle[0] ?? (takeMainCopyTurn(state) ? null : pool.leaseLeastBusy())
    if (lease === null) return null
    leases.push(lease)
    fork = patternWork.fork(1)
    const result = await lease.executor.execute<FanOutResult>(
      queryAction(indexName, params, globalStats, partitionIds, fork.shared),
    )
    fork.settle(result.patternWorkSpent ?? 0)
    return result
  } catch (err) {
    if (isWorkCapError(err)) throw err
    fork?.settle(0)
    console.warn('Worker search failed, falling back to local:', err)
    return null
  } finally {
    for (const lease of leases) lease.release()
  }
}
