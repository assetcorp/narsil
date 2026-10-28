import { ErrorCodes, NarsilError } from '../../errors'
import { decodePageCursor, encodePageCursor } from '../../search/cursor'
import { requireWithinHybridDepth, resolveHybridFusion } from '../../search/fusion'
import { ascendingFacetFields } from '../cluster-node/query-conversion'
import type {
  FacetBucket,
  GlobalStatistics,
  ScoredEntry,
  WireGroupEntry,
  WirePinnedEntry,
  WireQueryParams,
} from '../transport/types'
import { buildCoverage, collectDistributedStats, fanOutSearch } from './fan-out'
import { distributedLinearCombination, distributedRRF } from './fusion'
import { mergeGroupsFor } from './group-merge'
import { mergeAndTruncateScoredEntries, mergeDistributedFacets } from './merge'
import { lastOrganicEntry, placePinnedEntries } from './pinning'
import type { DistributedQueryConfig, DistributedQueryResult, QueryRoutingDeps, RoutingResult } from './types'

interface HybridPage {
  limit: number
  offset: number
  binding: string
}

function fusedPageCursor(
  placed: ScoredEntry[],
  fused: ScoredEntry[],
  start: number,
  page: ScoredEntry[],
  pinned: WirePinnedEntry[] | null,
  binding: string,
  depth: number,
): string | null {
  const last = lastOrganicEntry(page, pinned)
  if (last === undefined || Math.min(placed.length, depth) <= start + page.length) return null
  const reached =
    pinned === null ? start + page.lastIndexOf(last) + 1 : fused.findIndex(entry => entry.docId === last.docId) + 1
  return encodePageCursor({
    anchor: last.docId,
    score: last.score,
    sortKey: null,
    sortSignature: null,
    depth: reached,
    binding,
  })
}

/**
 * Runs a hybrid query across the cluster and returns the fused page. Two
 * fan-outs go to every target node, one per modality, and each fetches
 * `hybrid.depth` results, so every page of one query fuses the same two
 * globally merged lists. Under DFS scoring a statistics pre-pass adds a third
 * round trip. The text fan-out alone carries facets and grouping, which keeps
 * both counted once. The coordinator keeps the top `hybrid.depth` of the fused
 * list, takes the page from position d + offset, and writes a cursor whose
 * depth counts the fused list up to the last hit on the page that is not a
 * pinned placement.
 *
 * @param indexName - The index to search.
 * @param params - The wire query, which carries a vector and a term or a hybrid mode.
 * @param page - The page size, the count of fused results the page skips, and the request's cursor binding.
 * @param facetShardSize - The oversampled per-node facet bucket count, or null without facets.
 * @param facetSize - The facet bucket count the client asked for.
 * @param totalPartitions - The partition count of the index.
 * @param routing - The node targets and the partitions no replica serves.
 * @param deps - The transport, the source node id, and the allocation reader.
 * @param config - The partial-results policy and the partition timeout.
 * @returns The fused page, the cursor, the facets, the groups, and the coverage.
 * @throws A {@link NarsilError} carrying `SEARCH_RESULT_WINDOW_EXCEEDED` where the page ends past `hybrid.depth`.
 */
export async function executeHybridQuery(
  indexName: string,
  params: WireQueryParams,
  page: HybridPage,
  facetShardSize: number | null,
  facetSize: number,
  totalPartitions: number,
  routing: RoutingResult,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<DistributedQueryResult> {
  const fusion = resolveHybridFusion(params.hybrid)
  const depth = fusion.depth
  const cursorDepth = params.searchAfter === null ? 0 : (decodePageCursor(params.searchAfter).depth ?? 0)
  requireWithinHybridDepth(cursorDepth, page.offset, depth)
  const legParams: WireQueryParams = {
    ...params,
    hybrid: null,
    mode: null,
    sort: null,
    searchAfter: null,
    pinned: null,
    limit: depth,
    offset: 0,
  }
  const textParams: WireQueryParams = { ...legParams, vector: null }
  const vectorParams: WireQueryParams = {
    ...legParams,
    term: null,
    group: null,
    facets: null,
    facetSize: null,
  }

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
  const allGroups: WireGroupEntry[][] = []
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
    if (outcome.results.groups !== null && outcome.results.groups !== undefined) {
      allGroups.push(outcome.results.groups)
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

  let fused: ScoredEntry[]
  if (fusion.strategy === 'rrf') {
    fused = distributedRRF([mergedText, mergedVector], { k: fusion.k })
  } else {
    fused = distributedLinearCombination(mergedText, mergedVector, { alpha: fusion.alpha })
  }
  if (fused.length > depth) fused = fused.slice(0, depth)

  const allMatchesPresent =
    coverage.queriedPartitions === coverage.totalPartitions &&
    totalHits <= mergedText.length &&
    mergedVector.length < depth
  const placesPins = params.pinned !== null && params.searchAfter === null
  const placement =
    params.pinned !== null && placesPins
      ? placePinnedEntries(fused, params.pinned, depth, allMatchesPresent)
      : { entries: fused, placedFromOutside: [] }
  const start = cursorDepth + page.offset
  const end = Math.min(start + page.limit, depth)
  const truncated = end > start ? placement.entries.slice(start, end) : []
  const cursor = fusedPageCursor(
    placement.entries,
    fused,
    start,
    truncated,
    placesPins ? params.pinned : null,
    page.binding,
    depth,
  )
  const mergedFacets =
    allFacets.length > 0
      ? mergeDistributedFacets(allFacets, allFacetBounds, facetSize, ascendingFacetFields(params.facets))
      : null

  return {
    scored: truncated,
    totalHits,
    facets: mergedFacets?.facets ?? null,
    facetErrorBounds: mergedFacets?.errorBounds ?? null,
    facetUndercounts: mergedFacets?.undercounts ?? null,
    groups: mergeGroupsFor(params, allGroups, null),
    cursor,
    coverage,
    pinnedFromOutside: placement.placedFromOutside,
    mergeHeldEveryMatch: allMatchesPresent,
  }
}
