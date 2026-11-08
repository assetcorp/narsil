import type { SearchClock } from '../../core/search-clock'
import { bindSearchSignal, signalOfSearch } from '../../core/search-stop'
import { ErrorCodes, NarsilError } from '../../errors'
import type { FanOutResult } from '../../partitioning/fan-out'
import { RESULT_WINDOW } from '../../search/constants'
import { linearCombination, reciprocalRankFusion, resolveHybridFusion } from '../../search/fusion'
import type { ScoredDocument } from '../../types/internal'
import type { QueryParams, VectorQueryConfig } from '../../types/search'
import { MIN_OVERSAMPLE } from '../../vector/osq/constants'
import type { VectorSearcher, VectorSearchOptions, VectorSearchOutcome } from '../../vector/vector-index'
import type { FilteredSearch } from './filter-subsets'
import type { SearchContext } from './shared'
import { requirePinnedState } from './state'
import { filterSubsetsMatchNothing, searchCurrentSubsets } from './subset-search'
import type { VectorQueryHost } from './vector-query-host'

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

interface FieldSearch {
  readonly vecIndex: VectorSearcher
  readonly vectorConfig: VectorQueryConfig
  readonly queryVector: Float32Array
  readonly context: SearchContext
  readonly filtered: FilteredSearch | undefined
  readonly rescoreWindow: number | undefined
}

function vectorClock(context: SearchContext): SearchClock | undefined {
  const signal = signalOfSearch(context.turns)
  const clock = context.patternWork.clock
  if (signal === undefined) return clock
  const nativeWindow = clock?.nativeWindow
  const bound: SearchClock = {
    check() {
      signal.throwIfAborted()
      clock?.check()
    },
    tick(units) {
      signal.throwIfAborted()
      clock?.tick(units)
    },
    ...(nativeWindow === undefined ? {} : { nativeWindow: () => nativeWindow.call(clock) }),
  }
  bindSearchSignal(bound, signal)
  return bound
}

async function searchField(search: FieldSearch, k: number, host: VectorQueryHost): Promise<VectorSearchOutcome> {
  const { vecIndex, vectorConfig, queryVector, context, filtered, rescoreWindow } = search
  const options: VectorSearchOptions = {
    clock: vectorClock(context),
    metric: vectorConfig.metric ?? 'cosine',
    minSimilarity: vectorConfig.similarity ?? -Infinity,
    efSearch: vectorConfig.efSearch,
    oversample: oversampleOf(vectorConfig),
    ...(rescoreWindow !== undefined ? { rescoreWindow } : {}),
  }
  if (filtered !== undefined) {
    const outcome = await searchCurrentSubsets(
      vecIndex.fieldName,
      filtered.first,
      filtered.collectAgain,
      filterSubsets => vecIndex.searchParallel(queryVector, k, { ...options, filterSubsets }),
    )
    requirePinnedState(context.pin)
    return outcome
  }
  const filterPartitions = host.partitionsForVectorSearch(context.manager, vecIndex, context.partitionIds)
  const outcome = await vecIndex.searchParallel(
    queryVector,
    k,
    filterPartitions === undefined ? options : { ...options, filterPartitions },
  )
  requirePinnedState(context.pin)
  return outcome
}

export async function executeVectorSearch(
  host: VectorQueryHost,
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

  const vecIndex = host.resolveVectorIndex(context, vectorConfig.field)
  if (!vecIndex) {
    return { scored: [], totalMatched: 0 }
  }

  const filtered = host.filteredSearchOf(params, context)
  if (filtered !== undefined && filterSubsetsMatchNothing(filtered.first)) {
    return { scored: [], totalMatched: 0 }
  }

  const search: FieldSearch = {
    vecIndex,
    vectorConfig,
    queryVector: new Float32Array(vectorConfig.value),
    context,
    filtered,
    rescoreWindow: context.rescoreWindow,
  }
  const outcome = await searchField(search, vectorFetchDepth(limit, offset, cursorDepth), host)
  const scored = host.vectorResultsToScored(outcome.results)
  return { scored, totalMatched: outcome.matched, matchedExact: outcome.matchedExact }
}

export async function vectorLegWith(
  host: VectorQueryHost,
  vectorConfig: VectorQueryConfig,
  queryVector: Float32Array,
  context: SearchContext,
  filtered: FilteredSearch | undefined,
  k: number,
  rescoreWindow?: number,
): Promise<{ scored: ScoredDocument[]; holdsEveryMatch: boolean }> {
  const vecIndex = host.resolveVectorIndex(context, vectorConfig.field)
  if (!vecIndex) return { scored: [], holdsEveryMatch: true }
  const search: FieldSearch = { vecIndex, vectorConfig, queryVector, context, filtered, rescoreWindow }
  const outcome = await searchField(search, k, host)
  return {
    scored: host.vectorResultsToScored(outcome.results),
    holdsEveryMatch: outcome.matchedExact && outcome.results.length === outcome.matched,
  }
}

export async function executeHybridSearch(
  host: VectorQueryHost,
  params: QueryParams,
  context: SearchContext,
  limit: number,
  offset: number,
  cursorDepth = 0,
): Promise<FanOutResult> {
  const { vector: vectorConfig, mode: _mode, hybrid: _hybrid, ...textOnlyParams } = params
  const fusion = resolveHybridFusion(params.hybrid)

  const filtered = host.filteredSearchOf(params, context)
  if (filtered !== undefined && filterSubsetsMatchNothing(filtered.first)) {
    return { scored: [], totalMatched: 0 }
  }

  if (!vectorConfig || !vectorConfig.value) {
    const textOnly = await host.textLeg(textOnlyParams, context)
    return {
      scored: textOnly.scored,
      totalMatched: textOnly.totalMatched,
      facets: textOnly.facets,
      ...(textOnly.documents !== undefined ? { documents: textOnly.documents } : {}),
    }
  }

  const vectorPending = vectorLegWith(
    host,
    vectorConfig,
    new Float32Array(vectorConfig.value),
    context,
    filtered,
    vectorFetchDepth(limit, offset, cursorDepth),
  )
  const [textFanOutResult, vectorOutcome] = await Promise.all([host.textLeg(textOnlyParams, context), vectorPending])
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
    ...(textFanOutResult.documents !== undefined ? { documents: textFanOutResult.documents } : {}),
  }
}
