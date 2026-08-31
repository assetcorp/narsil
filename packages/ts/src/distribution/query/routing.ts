import { toComparableSortValue } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import { decodePageCursor, encodePageCursor, requireMatchingCursor } from '../../search/cursor'
import { queryBindingOf } from '../../search/cursor-binding'
import { requireWithinResultWindow } from '../../search/pagination'
import { wireParamsToLocal } from '../cluster-node/query-conversion'
import type { FacetBucket, GlobalStatistics, ScoredEntry, SortField, WireQueryParams } from '../transport/types'
import { buildCoverage, collectDistributedStats, fanOutSearch, type NodeQueryOutcome } from './fan-out'
import { clampAlpha, distributedLinearCombination, distributedRRF } from './fusion'
import { mergeAndTruncateScoredEntries, mergeAndTruncateSortedEntries, mergeDistributedFacets } from './merge'
import { placePinnedEntries } from './pinning'
import type { ReplicaSelector } from './selection'
import { randomSelector, selectReplicasForQuery } from './selection'
import type { DistributedQueryConfig, DistributedQueryResult, QueryRoutingDeps } from './types'
import { DEFAULT_QUERY_CONFIG } from './types'

export type { QueryRoutingDeps }

export const MAX_FACET_SIZE = 1_000

function wireSortSignature(sort: SortField[] | null): string | null {
  if (sort === null || sort.length === 0) return null
  return JSON.stringify(sort.map(field => [field.field, field.direction]))
}

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

  const binding = queryBindingOf(wireParamsToLocal(params))

  if (params.searchAfter !== null) {
    const decoded = decodePageCursor(params.searchAfter)
    requireMatchingCursor(decoded, params.searchAfter, wireSortSignature(params.sort), true, binding)
  }

  const limit = Math.max(params.limit, 0)
  const offset = Math.max(params.offset, 0)
  requireWithinResultWindow(limit, offset)
  const hasFacets = params.facets !== null && params.facets.length > 0
  const facetSize = resolveAndClampFacetSize(params.facetSize, resolvedConfig.defaultFacetSize)
  const facetShardSize = hasFacets ? Math.ceil(facetSize * 1.5) + 10 : null

  const allocationTable = await deps.getAllocation(indexName)
  if (allocationTable === null) {
    throw new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, `No allocation table found for index '${indexName}'`, {
      indexName,
    })
  }

  if (allocationTable.assignments.size === 0) {
    return {
      scored: [],
      totalHits: 0,
      facets: null,
      facetErrorBounds: null,
      cursor: null,
      coverage: { totalPartitions: 0, queriedPartitions: 0, timedOutPartitions: 0, failedPartitions: 0 },
    }
  }

  const routing = selectReplicasForQuery(allocationTable, selector ?? randomSelector)
  const totalPartitions = allocationTable.assignments.size

  if (routing.unavailablePartitions.length > 0 && !resolvedConfig.allowPartialResults) {
    throw new NarsilError(
      ErrorCodes.QUERY_PARTIAL_FAILURE,
      'No active replica serves one or more partitions, and this node refuses partial results',
      { unavailablePartitions: routing.unavailablePartitions },
    )
  }

  const isHybrid = params.hybrid !== null && params.term !== null && params.vector !== null

  if (isHybrid && params.searchAfter !== null) {
    throw new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, 'Cursor pagination is not supported for hybrid queries', {
      indexName,
    })
  }

  if (isHybrid && params.sort !== null && params.sort.length > 0) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_MODE,
      'A hybrid query cannot carry a sort, because fusion defines the order of hybrid results',
      { indexName },
    )
  }

  if (isHybrid) {
    return executeHybridQuery(
      indexName,
      params,
      binding,
      limit,
      offset,
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
    binding,
    limit,
    offset,
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
  binding: string,
  limit: number,
  offset: number,
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

  const depth = limit + offset
  const searchParams: WireQueryParams = { ...params, limit: depth, offset: 0 }

  const outcomes = await fanOutSearch(
    indexName,
    searchParams,
    globalStats,
    facetShardSize,
    routing.nodeToPartitions,
    deps,
    config,
  )

  const sortFields = params.sort !== null && params.sort.length > 0 ? params.sort : null
  if (sortFields !== null) {
    failOutcomesMissingSortValues(outcomes)
  }

  const coverage = buildCoverage(totalPartitions, routing.unavailablePartitions, outcomes)

  if (!config.allowPartialResults) {
    const failedCount = coverage.timedOutPartitions + coverage.failedPartitions
    if (failedCount > 0) {
      throw new NarsilError(ErrorCodes.QUERY_PARTIAL_FAILURE, 'One or more partitions failed during query', {
        coverage,
      })
    }
  }

  const allScored: ScoredEntry[][] = []
  const allFacets: Array<Record<string, FacetBucket[]>> = []
  const allFacetBounds: Array<Record<string, number> | null> = []
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
      allFacetBounds.push(outcome.results.facetErrorBounds)
    }
  }

  const merged =
    sortFields !== null
      ? mergeAndTruncateSortedEntries(
          allScored,
          depth,
          sortFields.map(field => field.direction),
        )
      : mergeAndTruncateScoredEntries(allScored, depth)
  const placed =
    params.pinned !== null && params.searchAfter === null ? placePinnedEntries(merged, params.pinned, depth) : merged
  const mergedScored = placed.slice(offset, depth)
  const mergedFacets = allFacets.length > 0 ? mergeDistributedFacets(allFacets, allFacetBounds, facetSize) : null

  let cursor: string | null = null
  if (mergedScored.length > 0) {
    const lastEntry = mergedScored[mergedScored.length - 1]
    cursor =
      sortFields !== null
        ? encodePageCursor({
            anchor: lastEntry.docId,
            score: null,
            sortKey: (lastEntry.sortValues ?? []).map(toComparableSortValue),
            sortSignature: wireSortSignature(sortFields),
            binding,
          })
        : encodePageCursor({
            anchor: lastEntry.docId,
            score: lastEntry.score,
            sortKey: null,
            sortSignature: null,
            binding,
          })
  }

  return {
    scored: mergedScored,
    totalHits,
    facets: mergedFacets?.facets ?? null,
    facetErrorBounds: mergedFacets?.errorBounds ?? null,
    cursor,
    coverage,
  }
}

function failOutcomesMissingSortValues(outcomes: NodeQueryOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.status !== 'success' || outcome.results === null) continue
    const missing = outcome.results.results.some(partition => partition.scored.some(entry => entry.sortValues === null))
    if (missing) {
      outcome.status = 'failed'
      outcome.results = null
    }
  }
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
  binding: string,
  limit: number,
  offset: number,
  facetShardSize: number | null,
  facetSize: number,
  totalPartitions: number,
  routing: RoutingResult,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<DistributedQueryResult> {
  const depth = limit + offset
  const textParams: WireQueryParams = { ...params, vector: null, hybrid: null, mode: null, limit: depth, offset: 0 }
  const vectorParams: WireQueryParams = { ...params, term: null, hybrid: null, mode: null, limit: depth, offset: 0 }

  let textGlobalStats: GlobalStatistics | null = null
  if (params.scoring === 'dfs') {
    textGlobalStats = await collectDistributedStats(indexName, textParams, routing.nodeToPartitions, deps, config)
  }

  const [textOutcomes, vectorOutcomes] = await Promise.all([
    fanOutSearch(indexName, textParams, textGlobalStats, facetShardSize, routing.nodeToPartitions, deps, config),
    fanOutSearch(indexName, vectorParams, null, null, routing.nodeToPartitions, deps, config),
  ])

  const coverage = buildCoverage(totalPartitions, routing.unavailablePartitions, textOutcomes, vectorOutcomes)

  if (!config.allowPartialResults) {
    const failedCount = coverage.timedOutPartitions + coverage.failedPartitions
    if (failedCount > 0) {
      throw new NarsilError(ErrorCodes.QUERY_PARTIAL_FAILURE, 'One or more partitions failed during hybrid query', {
        coverage,
      })
    }
  }

  const textScored: ScoredEntry[][] = []
  const vectorScored: ScoredEntry[][] = []
  const allFacets: Array<Record<string, FacetBucket[]>> = []
  const allFacetBounds: Array<Record<string, number> | null> = []
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
      allFacetBounds.push(outcome.results.facetErrorBounds)
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

  const mergedText = mergeAndTruncateScoredEntries(textScored, depth)
  const mergedVector = mergeAndTruncateScoredEntries(vectorScored, depth)

  const hybrid = params.hybrid
  let fused: ScoredEntry[]
  if (hybrid !== null && (hybrid.strategy ?? 'rrf') === 'rrf') {
    fused = distributedRRF([mergedText, mergedVector], { k: hybrid.k ?? 60 })
  } else if (hybrid !== null) {
    fused = distributedLinearCombination(mergedText, mergedVector, { alpha: clampAlpha(hybrid.alpha ?? 0.5) })
  } else {
    fused = mergedText
  }

  const fusedWithPinned = params.pinned !== null ? placePinnedEntries(fused, params.pinned, depth) : fused
  const truncated = fusedWithPinned.slice(offset, depth)
  const mergedFacets = allFacets.length > 0 ? mergeDistributedFacets(allFacets, allFacetBounds, facetSize) : null

  let cursor: string | null = null
  if (truncated.length > 0) {
    const lastEntry = truncated[truncated.length - 1]
    cursor = encodePageCursor({
      anchor: lastEntry.docId,
      score: lastEntry.score,
      sortKey: null,
      sortSignature: null,
      binding,
    })
  }

  return {
    scored: truncated,
    totalHits,
    facets: mergedFacets?.facets ?? null,
    facetErrorBounds: mergedFacets?.errorBounds ?? null,
    cursor,
    coverage,
  }
}
