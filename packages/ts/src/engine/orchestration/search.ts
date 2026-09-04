import { type FanOutResult, kWayMerge } from '../../partitioning/fan-out'
import { mergeFacets } from '../../search/facets'
import type { GlobalStatistics } from '../../types/internal'
import type { FacetResult } from '../../types/results'
import type { QueryParams } from '../../types/search'
import type { WorkerLease, WorkerPool } from '../../workers/pool'
import { createRequestId } from '../../workers/protocol'
import { afterCurrentTurn } from './turn'
import type { OrchestratorState } from './types'

function partitionsPerLease(scope: number[], leaseCount: number): number[][] {
  const assignments: number[][] = Array.from({ length: leaseCount }, () => [])
  for (let at = 0; at < scope.length; at++) {
    assignments[at % leaseCount].push(scope[at])
  }
  return assignments
}

function mergeWorkerResults(results: FanOutResult[]): FanOutResult {
  const merged = kWayMerge(results.map(result => result.scored))
  let totalMatched = 0
  const workerFacets: Array<Record<string, FacetResult>> = []
  for (const result of results) {
    totalMatched += result.totalMatched
    if (result.facets !== undefined) workerFacets.push(result.facets)
  }
  return {
    scored: merged,
    totalMatched,
    facets: workerFacets.length > 0 ? mergeFacets(workerFacets) : undefined,
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
) {
  return {
    type: 'query' as const,
    indexName,
    params,
    requestId: createRequestId(),
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
): Promise<FanOutResult> {
  const assignments = partitionsPerLease(scope, leases.length)
  const results = await Promise.all(
    assignments.map((partitionIds, at) =>
      leases[at].executor
        .execute<FanOutResult>(queryAction(indexName, params, globalStats, partitionIds))
        .finally(() => leases[at].release()),
    ),
  )
  return mergeWorkerResults(results)
}

function leaseUnlessMainCopyTurn(state: OrchestratorState, pool: WorkerPool): WorkerLease | null {
  if (state.mainCopyTurnTaken) return pool.leaseLeastBusy()
  state.mainCopyTurnTaken = true
  afterCurrentTurn(() => {
    state.mainCopyTurnTaken = false
  })
  return null
}

export async function searchViaWorker(
  state: OrchestratorState,
  indexName: string,
  params: QueryParams,
  globalStats?: GlobalStatistics,
  partitionIds?: number[],
): Promise<FanOutResult | null> {
  const pool = state.workerPool
  if (!pool) return null
  if (!state.scaledOutIndexes.has(indexName) || state.copyLoadBuffers.has(indexName)) return null
  const pendingReplication = state.replicationQueues.get(indexName)
  if (pendingReplication !== undefined && pendingReplication.pendingActions > 0) return null

  const manager = state.executor.getManager(indexName)
  if (!manager) return null

  const scope = partitionIds ?? Array.from({ length: manager.partitionCount }, (_, partitionId) => partitionId)
  const idle = pool.leaseIdle(scope.length)
  const leases: WorkerLease[] = []
  try {
    if (idle.length >= 2 && scoresPerPartition(state, indexName, params, globalStats)) {
      leases.push(...idle)
      return await runSplit(leases, scope, indexName, params, globalStats)
    }
    for (const lease of idle.slice(1)) lease.release()
    const lease = idle[0] ?? leaseUnlessMainCopyTurn(state, pool)
    if (lease === null) return null
    leases.push(lease)
    return await lease.executor.execute<FanOutResult>(queryAction(indexName, params, globalStats, partitionIds))
  } catch (err) {
    console.warn('Worker search failed, falling back to local:', err)
    return null
  } finally {
    for (const lease of leases) lease.release()
  }
}
