import { ErrorCodes, NarsilError } from '../../errors'
import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { HYBRID_RESCORE_WINDOW, RESULT_WINDOW } from '../../search/constants'
import { linearCombination, reciprocalRankFusion, resolveHybridFusion } from '../../search/fusion'
import type { ScoredDocument } from '../../types/internal'
import type { QueryParams, VectorQueryConfig } from '../../types/search'
import { MIN_OVERSAMPLE } from '../../vector/osq/constants'
import {
  broadcastStatsForWorker,
  collectFilterDocIds,
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

export async function executeVectorSearch(
  params: QueryParams,
  context: SearchContext,
  limit: number,
  offset: number,
  cursorDepth = 0,
): Promise<FanOutResult> {
  const { manager, config, partitionIds } = context
  const vectorConfig = params.vector
  if (!vectorConfig || !vectorConfig.value) {
    return { scored: [], totalMatched: 0 }
  }

  const vecIndex = resolveVectorIndex(context, vectorConfig.field)
  if (!vecIndex) {
    return { scored: [], totalMatched: 0 }
  }

  let filterDocIds: Set<string> | undefined
  let filterPartitions: ReadonlySet<number> | undefined
  if (params.filters) {
    filterDocIds = collectFilterDocIds(manager, params, config.schema, partitionIds, context.patternWork)
    if (filterDocIds.size === 0) {
      return { scored: [], totalMatched: 0 }
    }
  } else {
    filterPartitions = partitionsForVectorSearch(manager, vecIndex, partitionIds)
  }

  const queryVec = new Float32Array(vectorConfig.value)
  const k = vectorFetchDepth(limit, offset, cursorDepth)
  const outcome = await vecIndex.searchParallel(queryVec, k, {
    metric: vectorConfig.metric ?? 'cosine',
    minSimilarity: vectorConfig.similarity ?? -Infinity,
    ...(filterDocIds !== undefined ? { filterDocIds } : {}),
    ...(filterPartitions !== undefined ? { filterPartitions } : {}),
    efSearch: vectorConfig.efSearch,
    oversample: oversampleOf(vectorConfig),
    ...(context.rescoreWindow !== undefined ? { rescoreWindow: context.rescoreWindow } : {}),
  })

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
  filterDocIds: Set<string> | undefined,
  k: number,
): Promise<{ scored: ScoredDocument[]; holdsEveryMatch: boolean }> {
  const { manager } = context
  const vecIndex = resolveVectorIndex(context, vectorConfig.field)
  if (!vecIndex) return { scored: [], holdsEveryMatch: true }
  const filterPartitions =
    filterDocIds === undefined ? partitionsForVectorSearch(manager, vecIndex, context.partitionIds) : undefined
  const outcome = await vecIndex.searchParallel(queryVector, k, {
    metric: vectorConfig.metric ?? 'cosine',
    minSimilarity: vectorConfig.similarity ?? -Infinity,
    ...(filterDocIds !== undefined ? { filterDocIds } : {}),
    ...(filterPartitions !== undefined ? { filterPartitions } : {}),
    efSearch: vectorConfig.efSearch,
    oversample: oversampleOf(vectorConfig),
    rescoreWindow: HYBRID_RESCORE_WINDOW,
  })
  return {
    scored: vectorResultsToScored(outcome.results),
    holdsEveryMatch: outcome.matchedExact && outcome.results.length === outcome.matched,
  }
}

function countOfUnion(text: FanOutResult, vectorScored: ScoredDocument[]): number {
  const textIds = new Set<string>()
  for (const doc of text.scored) textIds.add(doc.docId)
  let vectorOnly = 0
  for (const doc of vectorScored) if (!textIds.has(doc.docId)) vectorOnly++
  if (text.scored.length === text.totalMatched) return text.totalMatched + vectorOnly
  return Math.max(text.totalMatched, text.scored.length + vectorOnly)
}

export async function executeHybridSearch(params: QueryParams, context: SearchContext): Promise<FanOutResult> {
  const { manager, config } = context
  const { vector: vectorConfig, mode: _mode, hybrid: _hybrid, searchAfter: _after, pinned: _pinned, ...rest } = params
  const fusion = resolveHybridFusion(params.hybrid)
  const textOnlyParams: QueryParams = { ...rest, limit: fusion.depth, offset: 0 }

  let filterDocIds: Set<string> | undefined
  if (params.filters) {
    filterDocIds = collectFilterDocIds(manager, params, config.schema, context.partitionIds, context.patternWork)
    if (filterDocIds.size === 0) {
      return { scored: [], totalMatched: 0 }
    }
  }

  if (!vectorConfig || !vectorConfig.value) {
    const textOnly = await textLeg(textOnlyParams, context)
    return { scored: textOnly.scored, totalMatched: textOnly.totalMatched, facets: textOnly.facets }
  }

  const vectorPending = vectorLeg(
    vectorConfig,
    new Float32Array(vectorConfig.value),
    context,
    filterDocIds,
    fusion.depth,
  )
  const [textFanOutResult, vectorOutcome] = await Promise.all([textLeg(textOnlyParams, context), vectorPending])
  const vectorScored = vectorOutcome.scored
  const textScored = textFanOutResult.scored.slice(0, fusion.depth)

  let fusedScored: ScoredDocument[]
  if (fusion.strategy === 'rrf') {
    fusedScored = reciprocalRankFusion([textScored, vectorScored], { k: fusion.k })
  } else {
    fusedScored = linearCombination(textScored, vectorScored, { alpha: fusion.alpha })
  }

  const textHoldsEveryMatch = textFanOutResult.scored.length === textFanOutResult.totalMatched
  let totalMatched: number
  let matchedExact = vectorOutcome.holdsEveryMatch && textHoldsEveryMatch
  if (params.minScore !== undefined && params.minScore > 0) {
    const threshold = params.minScore
    fusedScored = fusedScored.filter(doc => doc.score >= threshold)
    totalMatched = fusedScored.length
    matchedExact = matchedExact && textScored.length === textFanOutResult.totalMatched
  } else {
    totalMatched = countOfUnion(textFanOutResult, vectorScored)
  }

  return {
    scored: fusedScored.length > fusion.depth ? fusedScored.slice(0, fusion.depth) : fusedScored,
    totalMatched,
    matchedExact,
    facets: textFanOutResult.facets,
  }
}
