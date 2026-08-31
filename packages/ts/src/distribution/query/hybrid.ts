import { ErrorCodes, NarsilError } from '../../errors'
import type { FacetBucket, GlobalStatistics, ScoredEntry, WireGroupEntry, WireQueryParams } from '../transport/types'
import { buildCoverage, collectDistributedStats, fanOutSearch } from './fan-out'
import { clampAlpha, distributedLinearCombination, distributedRRF } from './fusion'
import { mergeGroupsFor } from './group-merge'
import { mergeAndTruncateScoredEntries, mergeDistributedFacets } from './merge'
import { placePinnedEntries } from './pinning'
import type { DistributedQueryConfig, DistributedQueryResult, QueryRoutingDeps, RoutingResult } from './types'

/**
 * Runs a hybrid query across the cluster and returns the fused page. Two
 * fan-outs go to every target node, one per modality, and the coordinator
 * fuses the two globally merged lists, so fusion never depends on any single
 * node's slice. Under DFS scoring a statistics pre-pass adds a third round
 * trip. The text fan-out alone carries facets and grouping, which keeps both
 * counted once, and the response carries no cursor, because fused ranks do
 * not seek.
 *
 * @param indexName - The index to search.
 * @param params - The wire query, which carries a vector and a term or a hybrid mode.
 * @param limit - The page size after the offset.
 * @param offset - The count of fused results the page skips.
 * @param facetShardSize - The oversampled per-node facet bucket count, or null without facets.
 * @param facetSize - The facet bucket count the client asked for.
 * @param totalPartitions - The partition count of the index.
 * @param routing - The node targets and the partitions no replica serves.
 * @param deps - The transport, the source node id, and the allocation reader.
 * @param config - The partial-results policy and the partition timeout.
 * @returns The fused page, the facets, the groups, and the coverage.
 */
export async function executeHybridQuery(
  indexName: string,
  params: WireQueryParams,
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
  const vectorParams: WireQueryParams = {
    ...params,
    term: null,
    hybrid: null,
    mode: null,
    group: null,
    limit: depth,
    offset: 0,
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

  const hybrid = params.hybrid
  let fused: ScoredEntry[]
  if ((hybrid?.strategy ?? 'rrf') === 'rrf') {
    fused = distributedRRF([mergedText, mergedVector], { k: hybrid?.k ?? 60 })
  } else {
    fused = distributedLinearCombination(mergedText, mergedVector, { alpha: clampAlpha(hybrid?.alpha ?? 0.5) })
  }

  const allMatchesPresent =
    coverage.queriedPartitions === coverage.totalPartitions &&
    totalHits <= mergedText.length &&
    mergedVector.length < depth
  const fusedWithPinned =
    params.pinned !== null ? placePinnedEntries(fused, params.pinned, depth, allMatchesPresent) : fused
  const truncated = fusedWithPinned.slice(offset, depth)
  const mergedFacets = allFacets.length > 0 ? mergeDistributedFacets(allFacets, allFacetBounds, facetSize) : null

  return {
    scored: truncated,
    totalHits,
    facets: mergedFacets?.facets ?? null,
    facetErrorBounds: mergedFacets?.errorBounds ?? null,
    groups: mergeGroupsFor(params, allGroups, null),
    cursor: null,
    coverage,
  }
}
