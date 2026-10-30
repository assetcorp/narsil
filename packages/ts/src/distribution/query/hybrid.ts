import { ErrorCodes, NarsilError } from '../../errors'
import { HYBRID_RESCORE_WINDOW } from '../../search/constants'
import { decodePageCursor, encodePageCursor } from '../../search/cursor'
import { resolveHybridFusion } from '../../search/fusion'
import { fixedHybridDepthOf, requireWithinHybridDepth } from '../../search/hybrid-depth'
import { pageByPosition } from '../../search/position-page'
import { ascendingFacetFields } from '../cluster-node/query-conversion'
import type { FacetBucket, GlobalStatistics, ScoredEntry, WireGroupEntry, WireQueryParams } from '../transport/types'
import { buildCoverage, collectDistributedStats, fanOutSearch } from './fan-out'
import { distributedLinearCombination, distributedRRF } from './fusion'
import { mergeGroupsFor } from './group-merge'
import { mergeAndTruncateScoredEntries, mergeDistributedFacets } from './merge'
import { placePinnedEntries } from './pinning'
import { collectSearchContexts, releaseSearchContexts, searchContextKeepAlive } from './search-contexts'
import type { DistributedQueryConfig, DistributedQueryResult, QueryRoutingDeps, RoutingResult } from './types'

interface HybridPage {
  limit: number
  offset: number
  binding: string
}

function positionedOf(entry: ScoredEntry): { id: string; score?: number; entry: ScoredEntry } {
  return entry.score === null ? { id: entry.docId, entry } : { id: entry.docId, score: entry.score, entry }
}

function pageLegsOf(params: WireQueryParams, depth: number): { text: WireQueryParams; vector: WireQueryParams } {
  return {
    text: { ...params, vector: null, hybrid: null, mode: null, limit: depth, offset: 0 },
    vector: {
      ...params,
      term: null,
      hybrid: null,
      mode: null,
      group: null,
      facets: null,
      facetSize: null,
      limit: depth,
      offset: 0,
    },
  }
}

function fixedLegsOf(params: WireQueryParams, depth: number): { text: WireQueryParams; vector: WireQueryParams } {
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
  return {
    text: { ...legParams, vector: null },
    vector: {
      ...legParams,
      vector: legParams.vector === null ? null : { ...legParams.vector, rescoreWindow: HYBRID_RESCORE_WINDOW },
      term: null,
      group: null,
      facets: null,
      facetSize: null,
    },
  }
}

function pageFixedDepth(
  placed: ScoredEntry[],
  fused: ScoredEntry[],
  pins: WireQueryParams['pinned'],
  allMatchesPresent: boolean,
  start: number,
  page: HybridPage,
  depth: number,
): { page: ScoredEntry[]; cursor: string | null } {
  const placedIds =
    pins === null
      ? undefined
      : new Set(pins.filter(entry => allMatchesPresent || entry.position < depth).map(entry => entry.docId))
  const paged = pageByPosition(placed.map(positionedOf), fused.map(positionedOf), {
    start,
    limit: page.limit,
    pinnedIds: placedIds,
    binding: page.binding,
    encodeCursor: encodePageCursor,
  })
  return { page: paged.page.map(hit => hit.entry), cursor: paged.cursor ?? null }
}

/**
 * Runs a hybrid query across the cluster and returns the fused page. Two
 * fan-outs go to every target node, one per modality, and the coordinator
 * fuses the two globally merged lists, so fusion never depends on any single
 * node's slice. Under DFS scoring a statistics pre-pass adds a third round
 * trip. The text fan-out alone carries facets and grouping, which keeps both
 * counted once. Where the query leaves `hybrid.depth` out, each fan-out
 * fetches the offset plus the limit, and the response carries no cursor,
 * because fused ranks do not seek. Where the query sets `hybrid.depth`, each
 * fan-out fetches that many results, so every page of one query fuses the
 * same two lists. The coordinator then takes the page from the depth that the
 * request's cursor carries, plus the offset, and it writes a cursor whose
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
 * @throws A {@link NarsilError} carrying `SEARCH_RESULT_WINDOW_EXCEEDED` where the query sets `hybrid.depth` and the page starts at that depth or beyond.
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
  const fixedDepth = fixedHybridDepthOf(params.hybrid)
  const cursorDepth =
    fixedDepth === undefined || params.searchAfter === null ? 0 : (decodePageCursor(params.searchAfter).depth ?? 0)
  if (fixedDepth !== undefined) requireWithinHybridDepth(cursorDepth, page.offset, fixedDepth)
  const depth = fixedDepth ?? page.limit + page.offset
  const { text: textParams, vector: vectorParams } =
    fixedDepth === undefined ? pageLegsOf(params, depth) : fixedLegsOf(params, depth)

  let textGlobalStats: GlobalStatistics | null = null
  if (params.scoring === 'dfs') {
    textGlobalStats = await collectDistributedStats(indexName, textParams, routing, deps, config)
  }

  const keepAliveMs = config.searchContexts
    ? searchContextKeepAlive(routing, config.partitionTimeout, deps.transport)
    : null
  const legs = await Promise.allSettled([
    fanOutSearch(indexName, textParams, textGlobalStats, facetShardSize, routing, deps, config, keepAliveMs),
    fanOutSearch(indexName, vectorParams, null, null, routing, deps, config, keepAliveMs),
  ])
  const answered = legs.flatMap(leg => (leg.status === 'fulfilled' ? [leg.value] : []))
  const contexts = collectSearchContexts(...answered)
  const failedLeg = legs.find((leg): leg is PromiseRejectedResult => leg.status === 'rejected')
  if (failedLeg !== undefined) {
    releaseSearchContexts(indexName, contexts.opened, deps)
    throw failedLeg.reason
  }
  const [textLeg, vectorLeg] = legs
  const textOutcomes = textLeg.status === 'fulfilled' ? textLeg.value : []
  const vectorOutcomes = vectorLeg.status === 'fulfilled' ? vectorLeg.value : []

  const coverage = buildCoverage(totalPartitions, routing.unavailablePartitions, textOutcomes, vectorOutcomes)

  if (!config.allowPartialResults) {
    const failedCount = coverage.timedOutPartitions + coverage.failedPartitions
    if (failedCount > 0) {
      releaseSearchContexts(indexName, contexts.opened, deps)
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
  let vectorHits = 0

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
      vectorHits += partitionResult.totalHits
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
  if (fixedDepth !== undefined && fused.length > depth) fused = fused.slice(0, depth)

  const allMatchesPresent =
    coverage.queriedPartitions === coverage.totalPartitions &&
    totalHits <= mergedText.length &&
    (fixedDepth === undefined
      ? mergedVector.length < depth
      : params.vector?.similarity === null && vectorHits <= mergedVector.length)
  const pins = fixedDepth === undefined || params.searchAfter === null ? params.pinned : null
  const placement =
    pins !== null
      ? placePinnedEntries(fused, pins, depth, allMatchesPresent)
      : { entries: fused, placedFromOutside: [] }
  const paged =
    fixedDepth === undefined
      ? { page: placement.entries.slice(page.offset, depth), cursor: null }
      : pageFixedDepth(placement.entries, fused, pins, allMatchesPresent, cursorDepth + page.offset, page, depth)
  const mergedFacets =
    allFacets.length > 0
      ? mergeDistributedFacets(allFacets, allFacetBounds, facetSize, ascendingFacetFields(params.facets))
      : null

  return {
    scored: paged.page,
    totalHits,
    facets: mergedFacets?.facets ?? null,
    facetErrorBounds: mergedFacets?.errorBounds ?? null,
    facetUndercounts: mergedFacets?.undercounts ?? null,
    groups: mergeGroupsFor(params, allGroups, null),
    cursor: paged.cursor,
    coverage,
    pinnedFromOutside: placement.placedFromOutside,
    mergeHeldEveryMatch: allMatchesPresent,
    contexts,
  }
}
