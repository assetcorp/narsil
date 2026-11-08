import { loadPrefixFor } from '../../core/partition/suggestion-code'
import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { countsWithoutScores, fanOutMatchCount } from '../../partitioning/match-count'
import { loadCursorPageFor } from '../../search/cursor-page-code'
import { loadFacetMergesFor } from '../../search/facets'
import { loadGroupingFor } from '../../search/grouping-code'
import { loadPhraseCodeFor } from '../../search/phrase-code'
import { loadPinningFor } from '../../search/pinning-code'
import { loadSortingFor } from '../../search/sorting-code'
import type { PreflightResult, QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { requireLoadedVectorCode } from '../../workers/vector-code'
import { now } from '../validation'
import { loadedRerankRuntime, loadRerankRuntime } from './fixed-depth-code'
import { runQuery } from './run'
import { runtimeHost } from './runtime-host'
import {
  bm25SettingFor,
  broadcastStatsForWorker,
  type PinnedQueryContext,
  requireKnownMode,
  requireUsablePhrases,
  requireVectorSearchable,
  type SearchContext,
  scoringConfigFor,
  searchOptionsFor,
  validQueryParams,
  vectorSearchersOf,
  withPatternWork,
} from './shared'
import { vectorQueryHost } from './vector-query-host'

export type { QueryContext } from './shared'

export function loadQueryCode(request: QueryParams): Promise<unknown> | null {
  const prefix = loadPrefixFor(request.prefix)
  const phrase = loadPhraseCodeFor(request.term)
  const cursor = loadCursorPageFor(request.searchAfter)
  const grouping = loadGroupingFor(request.group)
  const pinning = loadPinningFor(request.pinned)
  const facets = loadFacetMergesFor(request.facets)
  const sorting = loadSortingFor(request.sort, request.filters)
  const fixedDepth =
    (request.rerank !== undefined || (request.hybrid?.depth ?? null) !== null) && loadedRerankRuntime() === null
      ? loadRerankRuntime()
      : null
  if (
    phrase === null &&
    fixedDepth === null &&
    cursor === null &&
    grouping === null &&
    pinning === null &&
    facets === null &&
    sorting === null &&
    prefix === null
  )
    return null
  return Promise.all([phrase, fixedDepth, cursor, grouping, pinning, facets, sorting, prefix])
}

export function executeQuery<T = AnyDocument>(
  request: QueryParams,
  callerContext: PinnedQueryContext,
): Promise<QueryResult<T>> {
  const loading = loadQueryCode(request)
  if (loading !== null) return loading.then(() => executeQuery<T>(request, callerContext))
  if (request.rerank === undefined) return runQuery<T>(request, callerContext, callerContext.pin)
  const runtime = loadedRerankRuntime()
  if (runtime === null) return loadRerankRuntime().then(() => executeQuery<T>(request, callerContext))
  return runtime.executeRerankedQuery<T>(request, callerContext, executeQuery<T>, runtimeHost)
}

function fixedDepthHybridOf(params: QueryParams, context: SearchContext, limit: number): Promise<FanOutResult> {
  if ((params.hybrid?.depth ?? null) === null) {
    return requireLoadedVectorCode().executeHybridSearch(vectorQueryHost, params, context, limit, 0)
  }
  return loadRerankRuntime().then(runtime =>
    runtime.searchFixedDepthHybrid(params, context, { cursorDepth: 0, offset: 0, limit }, runtimeHost),
  )
}

export async function executePreflight(
  request: QueryParams,
  callerContext: PinnedQueryContext,
): Promise<PreflightResult> {
  const loading = loadQueryCode(request)
  if (loading !== null) await loading
  const context = withPatternWork(callerContext)
  const { manager, language, config, workerSearch, indexName } = context
  const startTime = now()

  requireKnownMode(request)
  const loadingSorting = loadSortingFor(request.sort, request.filters)
  const loadingGrouping = loadGroupingFor(request.group)
  const loadingFacets = loadFacetMergesFor(request.facets)
  if (loadingSorting !== null || loadingGrouping !== null || loadingFacets !== null)
    await Promise.all([loadingSorting, loadingGrouping, loadingFacets])
  const params = validQueryParams(request, config)
  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  const hasVector = params.vector !== undefined && params.vector.value !== undefined
  const isHybridMode = params.mode === 'hybrid' || (hasTerm && hasVector)
  const isVectorOnly = (params.mode === 'vector' || (hasVector && !hasTerm)) && !isHybridMode

  requireVectorSearchable(params, context, isVectorOnly || isHybridMode)
  const loadingPhraseCode = loadPhraseCodeFor(params.term)
  const loadingFacetCode = loadFacetMergesFor(params.facets)
  if (loadingPhraseCode !== null || loadingFacetCode !== null) await Promise.all([loadingPhraseCode, loadingFacetCode])
  if (!isVectorOnly) requireUsablePhrases(params, context)

  const requestedVectorField = params.vector?.field
  const hasGlobalVectorIndex =
    requestedVectorField !== undefined && vectorSearchersOf(context).has(requestedVectorField)

  let totalMatched: number
  let countExact = true

  const preflightLimit = 1000
  const preflightOffset = 0

  if (isVectorOnly && hasGlobalVectorIndex) {
    const result = await requireLoadedVectorCode().executeVectorSearch(
      vectorQueryHost,
      params,
      context,
      preflightLimit,
      preflightOffset,
    )
    totalMatched = result.totalMatched
    countExact = result.matchedExact !== false
  } else if (isHybridMode && hasGlobalVectorIndex) {
    const result = await fixedDepthHybridOf(params, context, preflightLimit)
    totalMatched = result.totalMatched
    countExact = result.matchedExact !== false
  } else if (countsWithoutScores(params)) {
    totalMatched = fanOutMatchCount(manager, params, language, config.schema, {
      searchOptions: searchOptionsFor(params, context),
      partitionIds: context.partitionIds,
    })
  } else {
    const scoring = scoringConfigFor(params, context)
    const workerResult = workerSearch
      ? await workerSearch(
          indexName,
          params,
          broadcastStatsForWorker(params, context, scoring),
          context.partitionIds,
          context.patternWork,
          bm25SettingFor(params, context),
        )
      : null
    if (workerResult) {
      totalMatched = workerResult.totalMatched
    } else {
      const fanOutResult = await fanOutQuery(
        manager,
        params,
        language,
        config.schema,
        scoring,
        searchOptionsFor(params, context),
      )
      totalMatched = fanOutResult.totalMatched
    }
  }

  const elapsed = now() - startTime
  return { count: totalMatched, countExact, elapsed }
}
