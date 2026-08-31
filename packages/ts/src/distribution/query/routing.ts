import { toComparableSortValue } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import { decodePageCursor, encodePageCursor, requireMatchingCursor } from '../../search/cursor'
import { queryBindingOf } from '../../search/cursor-binding'
import { requireWithinResultWindow } from '../../search/pagination'
import { wireParamsToLocal } from '../cluster-node/query-conversion'
import type {
  FacetBucket,
  GlobalStatistics,
  ScoredEntry,
  SortField,
  WireGroupEntry,
  WireQueryParams,
} from '../transport/types'
import { buildCoverage, collectDistributedStats, fanOutSearch, type NodeQueryOutcome } from './fan-out'
import { mergeGroupsFor } from './group-merge'
import { executeHybridQuery } from './hybrid'
import { mergeAndTruncateScoredEntries, mergeAndTruncateSortedEntries, mergeDistributedFacets } from './merge'
import { oversampledShardSize } from './oversample'
import { lastOrganicEntry, placePinnedEntries } from './pinning'
import type { ReplicaSelector } from './selection'
import { randomSelector, selectReplicasForQuery } from './selection'
import type { DistributedQueryConfig, DistributedQueryResult, QueryRoutingDeps, RoutingResult } from './types'
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
  const facetShardSize = hasFacets ? oversampledShardSize(facetSize) : null

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
      groups: null,
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

  const isHybrid = params.vector !== null && (params.term !== null || params.mode === 'hybrid')

  if (isHybrid && params.searchAfter !== null) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_CURSOR,
      'Cursor pagination is not supported for hybrid queries, because fused ranks do not seek',
      { indexName },
    )
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
  const allGroups: WireGroupEntry[][] = []
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

    if (outcome.results.groups !== null && outcome.results.groups !== undefined) {
      allGroups.push(outcome.results.groups)
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
  const allMatchesPresent = coverage.queriedPartitions === coverage.totalPartitions && totalHits <= merged.length
  const placed =
    params.pinned !== null && params.searchAfter === null
      ? placePinnedEntries(merged, params.pinned, depth, allMatchesPresent)
      : merged
  const mergedScored = placed.slice(offset, depth)
  const mergedFacets = allFacets.length > 0 ? mergeDistributedFacets(allFacets, allFacetBounds, facetSize) : null
  const mergedGroups = mergeGroupsFor(params, allGroups, sortFields)

  let cursor: string | null = null
  const lastEntry = lastOrganicEntry(mergedScored, params.searchAfter === null ? params.pinned : null)
  if (lastEntry !== undefined) {
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
    groups: mergedGroups,
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
