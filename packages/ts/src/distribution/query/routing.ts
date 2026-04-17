import { NarsilError } from '../../errors'
import type { FacetBucket, GlobalStatistics, ScoredEntry, WireQueryParams } from '../transport/types'
import { decodeDistributedCursor, encodeDistributedCursor } from './cursor'
import { buildCoverage, collectDistributedStats, fanOutSearch } from './fan-out'
import { clampAlpha, distributedLinearCombination, distributedRRF } from './fusion'
import { mergeAndTruncateScoredEntries, mergeDistributedFacets } from './merge'
import type { ReplicaSelector } from './selection'
import { hashBasedSelector, selectReplicasForQuery } from './selection'
import type { Coverage, DistributedQueryConfig, DistributedQueryResult, QueryRoutingDeps } from './types'
import { DEFAULT_QUERY_CONFIG } from './types'

export type { QueryRoutingDeps }

const MAX_QUERY_LIMIT = 10_000
export const MAX_FACET_SIZE = 1_000

function resolveAndClampFacetSize(paramsFacetSize: number | null, configDefault: number): number {
  const raw =
    paramsFacetSize !== null && Number.isFinite(paramsFacetSize) && Number.isInteger(paramsFacetSize)
      ? paramsFacetSize
      : configDefault
  return Math.min(Math.max(raw, 1), MAX_FACET_SIZE)
}

export async function distributedQuery(
  indexName: string,
  params: WireQueryParams,
  deps: QueryRoutingDeps,
  config?: Partial<DistributedQueryConfig>,
  selector?: ReplicaSelector,
): Promise<DistributedQueryResult> {
  const resolvedConfig: DistributedQueryConfig = {
    ...DEFAULT_QUERY_CONFIG,
    ...config,
  }

  if (params.searchAfter !== null) {
    decodeDistributedCursor(params.searchAfter)
  }

  const limit = Math.min(Math.max(params.limit, 0), MAX_QUERY_LIMIT)
  const hasFacets = params.facets !== null && params.facets.length > 0
  const facetSize = resolveAndClampFacetSize(params.facetSize, resolvedConfig.defaultFacetSize)
  const facetShardSize = hasFacets ? Math.ceil(facetSize * 1.5) + 10 : null

  const allocationTable = await deps.getAllocation(indexName)
  if (allocationTable === null) {
    throw new NarsilError('QUERY_ROUTING_FAILED', `No allocation table found for index '${indexName}'`, { indexName })
  }

  if (allocationTable.assignments.size === 0) {
    return {
      scored: [],
      totalHits: 0,
      facets: null,
      cursor: null,
      coverage: { totalPartitions: 0, queriedPartitions: 0, timedOutPartitions: 0, failedPartitions: 0 },
    }
  }

  const routing = selectReplicasForQuery(allocationTable, deps.sourceNodeId, selector ?? hashBasedSelector)
  const totalPartitions = allocationTable.assignments.size

  if (routing.unavailablePartitions.length > 0 && !resolvedConfig.allowPartialResults) {
    throw new NarsilError('QUERY_NO_ACTIVE_REPLICA', 'No active replica for one or more partitions', {
      unavailablePartitions: routing.unavailablePartitions,
    })
  }

  const isHybrid = params.hybrid !== null && params.term !== null && params.vector !== null

  if (isHybrid && params.searchAfter !== null) {
    throw new NarsilError('QUERY_ROUTING_FAILED', 'Cursor pagination is not supported for hybrid queries', {
      indexName,
    })
  }

  if (isHybrid) {
    return executeHybridQuery(
      indexName,
      params,
      limit,
      facetShardSize,
      facetSize,
      totalPartitions,
      routing,
      deps,
      resolvedConfig,
    )
  }

  return executeSingleFanOut(
    indexName,
    params,
    limit,
    facetShardSize,
    facetSize,
    totalPartitions,
    routing,
    deps,
    resolvedConfig,
  )
}

interface RoutingResult {
  nodeToPartitions: Map<string, number[]>
  unavailablePartitions: number[]
}

async function executeSingleFanOut(
  indexName: string,
  params: WireQueryParams,
  limit: number,
  facetShardSize: number | null,
  facetSize: number,
  totalPartitions: number,
  routing: RoutingResult,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<DistributedQueryResult> {
  let globalStats: GlobalStatistics | null = null
  if (params.scoring === 'dfs') {
    globalStats = await collectDistributedStats(indexName, params, routing.nodeToPartitions, deps, config)
  }

  const searchParams: WireQueryParams = globalStats !== null ? { ...params } : params

  const outcomes = await fanOutSearch(
    indexName,
    searchParams,
    globalStats,
    facetShardSize,
    routing.nodeToPartitions,
    deps,
    config,
  )

  const coverage = buildCoverage(totalPartitions, routing.unavailablePartitions.length, outcomes)

  if (!config.allowPartialResults) {
    const failedCount = coverage.timedOutPartitions + coverage.failedPartitions
    if (failedCount > 0) {
      throw new NarsilError('QUERY_PARTIAL_FAILURE', 'One or more partitions failed during query', {
        coverage,
      })
    }
  }

  const allScored: ScoredEntry[][] = []
  const allFacets: Array<Record<string, FacetBucket[]>> = []
  let totalHits = 0

  for (const outcome of outcomes) {
    if (outcome.status !== 'success' || outcome.results === null) continue

    for (const partitionResult of outcome.results.results) {
      totalHits += partitionResult.totalHits
      if (partitionResult.scored.length > 0) {
        allScored.push(partitionResult.scored)
      }
    }

    if (outcome.results.facets !== null) {
      allFacets.push(outcome.results.facets)
    }
  }

  const mergedScored = mergeAndTruncateScoredEntries(allScored, limit)
  const mergedFacets = allFacets.length > 0 ? mergeDistributedFacets(allFacets, facetSize) : null

  let cursor: string | null = null
  if (mergedScored.length > 0) {
    const lastEntry = mergedScored[mergedScored.length - 1]
    cursor = encodeDistributedCursor(lastEntry.score, lastEntry.docId)
  }

  return { scored: mergedScored, totalHits, facets: mergedFacets, cursor, coverage }
}

/**
 * Hybrid queries issue two separate fan-outs (text + vector) to every target
 * node, resulting in 2x message amplification compared to a single-modality
 * query. When DFS scoring is enabled, a stats pre-pass adds a third round-trip
 * per node (3x total). The text fan-out carries facet shard sizes; the vector
 * fan-out does not request facets to avoid double-counting.
 */
async function executeHybridQuery(
  indexName: string,
  params: WireQueryParams,
  limit: number,
  facetShardSize: number | null,
  facetSize: number,
  totalPartitions: number,
  routing: RoutingResult,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<DistributedQueryResult> {
  const textParams: WireQueryParams = { ...params, vector: null, hybrid: null }
  const vectorParams: WireQueryParams = { ...params, term: null, hybrid: null }

  let textGlobalStats: GlobalStatistics | null = null
  if (params.scoring === 'dfs') {
    textGlobalStats = await collectDistributedStats(indexName, textParams, routing.nodeToPartitions, deps, config)
  }

  const [textOutcomes, vectorOutcomes] = await Promise.all([
    fanOutSearch(indexName, textParams, textGlobalStats, facetShardSize, routing.nodeToPartitions, deps, config),
    fanOutSearch(indexName, vectorParams, null, null, routing.nodeToPartitions, deps, config),
  ])

  const textCoverage = buildCoverage(totalPartitions, routing.unavailablePartitions.length, textOutcomes)
  const vectorCoverage = buildCoverage(totalPartitions, routing.unavailablePartitions.length, vectorOutcomes)
  const coverage = worstCaseCoverage(textCoverage, vectorCoverage)

  if (!config.allowPartialResults) {
    const failedCount = coverage.timedOutPartitions + coverage.failedPartitions
    if (failedCount > 0) {
      throw new NarsilError('QUERY_PARTIAL_FAILURE', 'One or more partitions failed during hybrid query', {
        coverage,
      })
    }
  }

  const textScored: ScoredEntry[][] = []
  const vectorScored: ScoredEntry[][] = []
  const allFacets: Array<Record<string, FacetBucket[]>> = []
  let totalHits = 0

  for (const outcome of textOutcomes) {
    if (outcome.status !== 'success' || outcome.results === null) continue
    for (const partitionResult of outcome.results.results) {
      totalHits += partitionResult.totalHits
      if (partitionResult.scored.length > 0) {
        textScored.push(partitionResult.scored)
      }
    }
    if (outcome.results.facets !== null) {
      allFacets.push(outcome.results.facets)
    }
  }

  for (const outcome of vectorOutcomes) {
    if (outcome.status !== 'success' || outcome.results === null) continue
    for (const partitionResult of outcome.results.results) {
      if (partitionResult.scored.length > 0) {
        vectorScored.push(partitionResult.scored)
      }
    }
  }

  const mergedText = mergeAndTruncateScoredEntries(textScored, limit)
  const mergedVector = mergeAndTruncateScoredEntries(vectorScored, limit)

  const hybrid = params.hybrid
  let fused: ScoredEntry[]
  if (hybrid !== null && hybrid.strategy === 'rrf') {
    fused = distributedRRF([mergedText, mergedVector], { k: hybrid.k })
  } else if (hybrid !== null) {
    fused = distributedLinearCombination(mergedText, mergedVector, { alpha: clampAlpha(hybrid.alpha) })
  } else {
    fused = mergedText
  }

  const truncated = fused.slice(0, limit)
  const mergedFacets = allFacets.length > 0 ? mergeDistributedFacets(allFacets, facetSize) : null

  let cursor: string | null = null
  if (truncated.length > 0) {
    const lastEntry = truncated[truncated.length - 1]
    cursor = encodeDistributedCursor(lastEntry.score, lastEntry.docId)
  }

  return { scored: truncated, totalHits, facets: mergedFacets, cursor, coverage }
}

function worstCaseCoverage(a: Coverage, b: Coverage): Coverage {
  const failed = Math.max(a.failedPartitions, b.failedPartitions)
  const timedOut = Math.max(a.timedOutPartitions, b.timedOutPartitions)
  const queried = Math.max(0, a.totalPartitions - failed - timedOut)
  return {
    totalPartitions: a.totalPartitions,
    queriedPartitions: queried,
    timedOutPartitions: timedOut,
    failedPartitions: failed,
  }
}
