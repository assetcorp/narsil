import type { FacetMatchSet, PartitionIndex } from '../core/partition'
import { kWayMerge } from '../core/partition/scored-merge'
import { mergeFacets } from '../search/facets'
import { type FulltextSearchOptions, fulltextSearch } from '../search/fulltext'
import type { GlobalStatistics, InternalSearchResult, ScoredDocument } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { FacetResult } from '../types/results'
import type { SchemaDefinition, ScoringMode } from '../types/schema'
import type { QueryParams } from '../types/search'
import { collectQueryTermStats } from './distributed-scoring'
import type { PartitionManager } from './manager'

export interface FanOutConfig {
  scoringMode: ScoringMode
  globalStats?: GlobalStatistics
  dispatcher?: PartitionSearchDispatcher
  partitionIds?: number[]
}

export interface FanOutResult {
  scored: ScoredDocument[]
  totalMatched: number
  facets?: Record<string, FacetResult>
}

interface PartitionSearchOutcome {
  result: InternalSearchResult
  partition: PartitionIndex
}

export interface PartitionSearchDispatcher {
  dispatch(
    partition: PartitionIndex,
    params: QueryParams,
    language: LanguageModule,
    schema: SchemaDefinition,
    options: FulltextSearchOptions,
  ): Promise<InternalSearchResult>
}

export async function fanOutQuery(
  manager: PartitionManager,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  config: FanOutConfig,
  searchOptions?: FulltextSearchOptions,
): Promise<FanOutResult> {
  const partitions: PartitionIndex[] = config.partitionIds
    ? config.partitionIds.map(id => manager.partitionAt(id)).filter((p): p is PartitionIndex => p !== undefined)
    : manager.getAllPartitions()

  if (partitions.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  let globalStats: GlobalStatistics | undefined
  const effectiveMode = resolveEffectiveMode(config)

  if (effectiveMode === 'dfs') {
    if (params.term !== undefined && params.term.trim().length > 0) {
      globalStats = collectQueryTermStats(manager, params.term, language, {
        stopWords: searchOptions?.stopWords,
        customTokenizer: searchOptions?.customTokenizer,
      })
    }
  } else if (effectiveMode === 'broadcast') {
    globalStats = config.globalStats
  }

  const options = buildSearchOptions(searchOptions, globalStats)

  if (partitions.length === 1 && !config.dispatcher) {
    const result = dispatchSinglePartition(partitions[0], params, language, schema, options)
    let facets: Record<string, FacetResult> | undefined
    if (params.facets) {
      facets = partitions[0].computeFacets(facetMatchSetOf(result), params.facets, schema)
    }
    return { scored: result.scored, totalMatched: result.totalMatched, facets }
  }

  let outcomes: PartitionSearchOutcome[]
  let facets: Record<string, FacetResult> | undefined

  if (config.dispatcher) {
    outcomes = await dispatchWithDispatcher(partitions, params, language, schema, options, config.dispatcher)
    if (params.facets) {
      facets = collectAndMergeFacets(outcomes, params, schema)
    }
  } else {
    outcomes = []
    const partitionFacets: Array<Record<string, FacetResult>> = []
    for (const partition of partitions) {
      const result = dispatchSinglePartition(partition, params, language, schema, options)
      if (params.facets) {
        partitionFacets.push(partition.computeFacets(facetMatchSetOf(result), params.facets, schema))
      }
      outcomes.push({ result, partition })
    }
    if (params.facets) {
      facets = mergeFacets(partitionFacets)
    }
  }

  const allScoredArrays = outcomes.map(o => o.result.scored)
  const merged = kWayMerge(allScoredArrays)

  let totalMatched = 0
  for (const outcome of outcomes) {
    totalMatched += outcome.result.totalMatched
  }

  return { scored: merged, totalMatched, facets }
}

function facetMatchSetOf(result: InternalSearchResult): FacetMatchSet {
  if (result.matchedOrdinalBitset !== undefined) {
    return { ordinalBitset: result.matchedOrdinalBitset }
  }
  return new Set(result.matchedIds ?? [])
}

function resolveEffectiveMode(config: FanOutConfig): ScoringMode {
  if (config.scoringMode === 'broadcast' && !config.globalStats) {
    return 'dfs'
  }
  return config.scoringMode
}

function buildSearchOptions(
  base: FulltextSearchOptions | undefined,
  globalStats: GlobalStatistics | undefined,
): FulltextSearchOptions {
  return {
    ...base,
    globalStats: globalStats ?? base?.globalStats,
  }
}

function dispatchWithDispatcher(
  partitions: PartitionIndex[],
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options: FulltextSearchOptions,
  dispatcher: PartitionSearchDispatcher,
): Promise<PartitionSearchOutcome[]> {
  const promises = partitions.map(partition =>
    dispatcher.dispatch(partition, params, language, schema, options).then(result => ({ result, partition })),
  )
  return Promise.all(promises)
}

function dispatchSinglePartition(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options: FulltextSearchOptions,
): InternalSearchResult {
  return fulltextSearch(partition, params, language, schema, options)
}

function collectAndMergeFacets(
  outcomes: PartitionSearchOutcome[],
  params: QueryParams,
  schema: SchemaDefinition,
): Record<string, FacetResult> {
  const partitionFacets: Array<Record<string, FacetResult>> = []

  for (const outcome of outcomes) {
    if (!params.facets) continue
    const facetResult = outcome.partition.computeFacets(facetMatchSetOf(outcome.result), params.facets, schema)
    partitionFacets.push(facetResult)
  }

  return mergeFacets(partitionFacets)
}

export { kWayMerge } from '../core/partition/scored-merge'
