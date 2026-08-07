import { type FanOutResult, kWayMerge } from '../../partitioning/fan-out'
import { mergeFacets } from '../../search/facets'
import type { GlobalStatistics } from '../../types/internal'
import type { FacetResult } from '../../types/results'
import type { QueryParams } from '../../types/search'
import type { Executor } from '../../workers/executor'
import { createRequestId } from '../../workers/protocol'
import type { OrchestratorState } from './types'

function partitionsPerWorker(totalPartitions: number, workerCount: number): number[][] {
  const assignments: number[][] = Array.from({ length: workerCount }, () => [])
  for (let partitionId = 0; partitionId < totalPartitions; partitionId++) {
    assignments[partitionId % workerCount].push(partitionId)
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

export async function searchViaWorker(
  state: OrchestratorState,
  indexName: string,
  params: QueryParams,
  globalStats?: GlobalStatistics,
): Promise<FanOutResult | null> {
  const pool = state.workerPool
  if (!pool) return null
  if (!state.promotedIndexes.has(indexName)) return null
  if (state.awaitingBufferedWrites.has(indexName)) return null

  const manager = state.executor.getManager(indexName)
  if (!manager) return null

  const allExecutors = pool.getAllExecutors()
  if (allExecutors.length === 0) return null

  const stats = globalStats !== undefined ? { globalStats } : {}

  if (allExecutors.length === 1) {
    try {
      return await allExecutors[0].execute<FanOutResult>({
        type: 'query',
        indexName,
        params,
        requestId: createRequestId(),
        ...stats,
      })
    } catch (err) {
      console.warn('Worker search failed, falling back to local:', err)
      return null
    }
  }

  const assignments = partitionsPerWorker(manager.partitionCount, allExecutors.length)

  try {
    const results = await Promise.all(
      allExecutors.map((workerExecutor: Executor, index: number) =>
        workerExecutor.execute<FanOutResult>({
          type: 'query',
          indexName,
          params,
          requestId: createRequestId(),
          partitionIds: assignments[index],
          ...stats,
        }),
      ),
    )
    return mergeWorkerResults(results)
  } catch (err) {
    console.warn('Parallel worker search failed, falling back to local:', err)
    return null
  }
}
