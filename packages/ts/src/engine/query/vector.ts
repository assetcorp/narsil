import { ErrorCodes, NarsilError } from '../../errors'
import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { RESULT_WINDOW } from '../../search/constants'
import { linearCombination, reciprocalRankFusion, resolveHybridFusion } from '../../search/fusion'
import type { ScoredDocument } from '../../types/internal'
import type { QueryParams, VectorQueryConfig } from '../../types/search'
import type { FilterSubset } from '../../vector/filter-ordinals'
import { MIN_OVERSAMPLE } from '../../vector/osq/constants'
import type { VectorSearcher, VectorSearchOptions, VectorSearchOutcome } from '../../vector/vector-index'
import { collectFilterSubsets, filterSubsetsMatchNothing, searchCurrentSubsets } from './filter-subsets'
import {
  broadcastStatsForWorker,
  partitionsForVectorSearch,
  type QueryContext,
  resolveVectorIndex,
  type SearchContext,
  scoringConfigFor,
  searchOptionsFor,
  vectorResultsToScored,
} from './shared'

export function oversampleOf(vectorConfig: VectorQueryConfig): number | undefined {
  const oversample: unknown = vectorConfig.oversample
  if (oversample === undefined) return undefined
  if (typeof oversample !== 'number' || !Number.isFinite(oversample) || oversample < MIN_OVERSAMPLE) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `vector.oversample must be a finite number of at least ${MIN_OVERSAMPLE}`,
      { oversample },
    )
  }
  return oversample
}

export function vectorFetchDepth(limit: number, offset: number, cursorDepth: number): number {
  const reach = cursorDepth + offset + limit
  if (reach > RESULT_WINDOW) {
    throw new NarsilError(
      ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED,
      `The engine pages a vector search through the first ${RESULT_WINDOW} results, and this page ends at ${reach}. Narrow the search with a filter or a similarity floor`,
      { limit, offset, cursorDepth, window: RESULT_WINDOW },
    )
  }
  return Math.min(reach + 1, RESULT_WINDOW)
}

interface FilteredSearch {
  readonly first: FilterSubset[]
  readonly collectAgain: () => FilterSubset[]
}

function filteredSearchOf(params: QueryParams, context: SearchContext): FilteredSearch | undefined {
  const filters = params.filters
  if (!filters) return undefined
  const { manager, config, partitionIds, patternWork } = context
  const collectAgain = () => collectFilterSubsets(manager, filters, config.schema, partitionIds, patternWork)
  return { first: collectAgain(), collectAgain }
}

function searchField(
  vecIndex: VectorSearcher,
  vectorConfig: VectorQueryConfig,
  queryVector: Float32Array,
  k: number,
  context: QueryContext,
  filtered: FilteredSearch | undefined,
): Promise<VectorSearchOutcome> {
  const options: VectorSearchOptions = {
    metric: vectorConfig.metric ?? 'cosine',
    minSimilarity: vectorConfig.similarity ?? -Infinity,
    efSearch: vectorConfig.efSearch,
    oversample: oversampleOf(vectorConfig),
  }
  if (filtered !== undefined) {
    return searchCurrentSubsets(vecIndex.fieldName, filtered.first, filtered.collectAgain, filterSubsets =>
      vecIndex.searchParallel(queryVector, k, { ...options, filterSubsets }),
    )
  }
  const filterPartitions = partitionsForVectorSearch(context.manager, vecIndex, context.partitionIds)
  return vecIndex.searchParallel(
    queryVector,
    k,
    filterPartitions === undefined ? options : { ...options, filterPartitions },
  )
}

export async function executeVectorSearch(
  params: QueryParams,
  context: SearchContext,
  limit: number,
  offset: number,
  cursorDepth = 0,
): Promise<FanOutResult> {
  const vectorConfig = params.vector
  if (!vectorConfig || !vectorConfig.value) {
    return { scored: [], totalMatched: 0 }
  }

  const vecIndex = resolveVectorIndex(context, vectorConfig.field)
  if (!vecIndex) {
    return { scored: [], totalMatched: 0 }
  }

  const filtered = filteredSearchOf(params, context)
  if (filtered !== undefined && filterSubsetsMatchNothing(filtered.first)) {
    return { scored: [], totalMatched: 0 }
  }

  const queryVec = new Float32Array(vectorConfig.value)
  const k = vectorFetchDepth(limit, offset, cursorDepth)
  const outcome = await searchField(vecIndex, vectorConfig, queryVec, k, context, filtered)

  const scored = vectorResultsToScored(outcome.results)
  return { scored, totalMatched: outcome.matched, matchedExact: outcome.matchedExact }
}

async function textLeg(textOnlyParams: QueryParams, context: SearchContext): Promise<FanOutResult> {
  const { manager, language, config, workerSearch, indexName } = context
  const scoring = scoringConfigFor(textOnlyParams, context)
  if (workerSearch) {
    const viaWorker = await workerSearch(
      indexName,
      textOnlyParams,
      broadcastStatsForWorker(textOnlyParams, context, scoring),
      context.partitionIds,
      context.patternWork,
    )
    if (viaWorker) return viaWorker
  }
  return fanOutQuery(
    manager,
    textOnlyParams,
    language,
    config.schema,
    scoring,
    searchOptionsFor(manager, context.patternWork),
  )
}

async function vectorLeg(
  vectorConfig: VectorQueryConfig,
  queryVector: Float32Array,
  context: QueryContext,
  filtered: FilteredSearch | undefined,
  k: number,
): Promise<{ scored: ScoredDocument[]; holdsEveryMatch: boolean }> {
  const vecIndex = resolveVectorIndex(context, vectorConfig.field)
  if (!vecIndex) return { scored: [], holdsEveryMatch: true }
  const outcome = await searchField(vecIndex, vectorConfig, queryVector, k, context, filtered)
  return {
    scored: vectorResultsToScored(outcome.results),
    holdsEveryMatch: outcome.matchedExact && outcome.results.length === outcome.matched,
  }
}

export async function executeHybridSearch(
  params: QueryParams,
  context: SearchContext,
  limit: number,
  offset: number,
  cursorDepth = 0,
): Promise<FanOutResult> {
  const { vector: vectorConfig, mode: _mode, hybrid: _hybrid, ...textOnlyParams } = params
  const fusion = resolveHybridFusion(params.hybrid)

  const filtered = filteredSearchOf(params, context)
  if (filtered !== undefined && filterSubsetsMatchNothing(filtered.first)) {
    return { scored: [], totalMatched: 0 }
  }

  if (!vectorConfig || !vectorConfig.value) {
    const textOnly = await textLeg(textOnlyParams, context)
    return { scored: textOnly.scored, totalMatched: textOnly.totalMatched, facets: textOnly.facets }
  }

  const vectorPending = vectorLeg(
    vectorConfig,
    new Float32Array(vectorConfig.value),
    context,
    filtered,
    vectorFetchDepth(limit, offset, cursorDepth),
  )
  const [textFanOutResult, vectorOutcome] = await Promise.all([textLeg(textOnlyParams, context), vectorPending])
  const vectorScored = vectorOutcome.scored

  let fusedScored: ScoredDocument[]
  if (fusion.strategy === 'rrf') {
    fusedScored = reciprocalRankFusion([textFanOutResult.scored, vectorScored], { k: fusion.k })
  } else {
    fusedScored = linearCombination(textFanOutResult.scored, vectorScored, { alpha: fusion.alpha })
  }

  if (params.minScore !== undefined && params.minScore > 0) {
    const threshold = params.minScore
    fusedScored = fusedScored.filter(doc => doc.score >= threshold)
  }

  const textHoldsEveryMatch = textFanOutResult.scored.length === textFanOutResult.totalMatched

  return {
    scored: fusedScored,
    totalMatched: fusedScored.length,
    matchedExact: vectorOutcome.holdsEveryMatch && textHoldsEveryMatch,
    facets: textFanOutResult.facets,
  }
}
