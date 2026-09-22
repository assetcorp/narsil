import { ErrorCodes, NarsilError } from '../../errors'
import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { RESULT_WINDOW } from '../../search/constants'
import { linearCombination, reciprocalRankFusion } from '../../search/fusion'
import type { ScoredDocument } from '../../types/internal'
import type { QueryParams, VectorQueryConfig } from '../../types/search'
import { MIN_OVERSAMPLE } from '../../vector/osq/constants'
import {
  broadcastStatsForWorker,
  clampAlpha,
  collectFilterDocIds,
  partitionsForVectorSearch,
  type QueryContext,
  resolveVectorIndex,
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
      `A vector search reaches the first ${RESULT_WINDOW} results, and this page ends at ${reach}. Narrow the search with a filter or a similarity floor`,
      { limit, offset, cursorDepth, window: RESULT_WINDOW },
    )
  }
  return Math.min(reach + 1, RESULT_WINDOW)
}

export async function executeVectorSearch(
  params: QueryParams,
  context: QueryContext,
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
    filterDocIds = collectFilterDocIds(manager, params, config.schema, partitionIds)
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
  })

  const scored = vectorResultsToScored(outcome.results)
  return { scored, totalMatched: outcome.matched, matchedExact: outcome.matchedExact }
}

async function textLeg(textOnlyParams: QueryParams, context: QueryContext): Promise<FanOutResult> {
  const { manager, language, config, workerSearch, indexName } = context
  const scoring = scoringConfigFor(textOnlyParams, context)
  if (workerSearch) {
    const viaWorker = await workerSearch(
      indexName,
      textOnlyParams,
      broadcastStatsForWorker(textOnlyParams, context, scoring),
      context.partitionIds,
    )
    if (viaWorker) return viaWorker
  }
  return fanOutQuery(manager, textOnlyParams, language, config.schema, scoring, searchOptionsFor(manager))
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
  })
  return {
    scored: vectorResultsToScored(outcome.results),
    holdsEveryMatch: outcome.matchedExact && outcome.results.length === outcome.matched,
  }
}

export async function executeHybridSearch(
  params: QueryParams,
  context: QueryContext,
  limit: number,
  offset: number,
  cursorDepth = 0,
): Promise<FanOutResult> {
  const { manager, config } = context
  const { vector: vectorConfig, mode: _mode, hybrid: _hybrid, ...textOnlyParams } = params

  let filterDocIds: Set<string> | undefined
  if (params.filters) {
    filterDocIds = collectFilterDocIds(manager, params, config.schema, context.partitionIds)
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
    vectorFetchDepth(limit, offset, cursorDepth),
  )
  const [textFanOutResult, vectorOutcome] = await Promise.all([textLeg(textOnlyParams, context), vectorPending])
  const vectorScored = vectorOutcome.scored

  const hybridConfig = params.hybrid ?? {}
  const strategy = hybridConfig.strategy ?? 'rrf'

  let fusedScored: ScoredDocument[]
  if (strategy === 'rrf') {
    const rrfK = hybridConfig.k !== undefined && hybridConfig.k > 0 ? hybridConfig.k : 60
    fusedScored = reciprocalRankFusion([textFanOutResult.scored, vectorScored], { k: rrfK })
  } else {
    const alpha = clampAlpha(hybridConfig.alpha)
    fusedScored = linearCombination(textFanOutResult.scored, vectorScored, { alpha })
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
