import { resolveProjection } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import { fanOutQuery } from '../../partitioning/fan-out'
import type { HitReads, StatePin } from '../../partitioning/manager/state-pins'
import { decodePageCursor, requireMatchingCursor, sortSignatureOf } from '../../search/cursor'
import type { CursorBinding } from '../../search/cursor-binding'
import { requireWithinResultWindow } from '../../search/pagination'
import { normalizeSort } from '../../search/sorting'
import { executeSortedQueryPage, sortsWithoutScores } from '../../search/sorting-code'
import type { GroupResult, Hit, QueryResult } from '../../types/results'
import type { QueryParams } from '../../types/search'
import { requireLoadedVectorCode } from '../../workers/vector-code'
import { clampLimit, clampOffset, now } from '../validation'
import {
  fillHits,
  type HighlightSettings,
  type PageRequest,
  type RankedFanOut,
  type RankedPage,
  rankPage,
} from './assemble'
import { copyReads } from './copy-reads'
import { loadedRerankRuntime, loadRerankRuntime } from './fixed-depth-code'
import { runtimeHost } from './runtime-host'
import {
  bm25SettingFor,
  broadcastStatsForWorker,
  coverageFor,
  type QueryContext,
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
import { requirePinnedState } from './state'
import { vectorQueryHost } from './vector-query-host'

interface QueryShape {
  readonly params: QueryParams
  readonly page: PageRequest
  readonly isVectorOnly: boolean
  readonly isHybridMode: boolean
  readonly hasTerm: boolean
  readonly highlighting: HighlightSettings
}

function requireCursorDepth(cursor: string | undefined, signature: string | null, binding: CursorBinding): number {
  if (cursor === undefined) return 0
  const decoded = decodePageCursor(cursor)
  requireMatchingCursor(decoded, cursor, signature, true, binding())
  return decoded.depth ?? 0
}

function hybridSearchOf(
  params: QueryParams,
  context: SearchContext,
  limit: number,
  offset: number,
  cursorDepth: number,
): Promise<RankedFanOut> {
  if ((params.hybrid?.depth ?? null) === null) {
    return requireLoadedVectorCode().executeHybridSearch(vectorQueryHost, params, context, limit, offset, cursorDepth)
  }
  const runtime = loadedRerankRuntime()
  if (runtime !== null) {
    return runtime.searchFixedDepthHybrid(params, context, { cursorDepth, offset, limit }, runtimeHost)
  }
  return loadRerankRuntime().then(loaded =>
    loaded.searchFixedDepthHybrid(params, context, { cursorDepth, offset, limit }, runtimeHost),
  )
}

function withPinnedVectors<T>(ranked: RankedPage<T>, pin: StatePin, page: PageRequest): RankedPage<T> {
  if (page.projection.kind === 'none') return ranked
  const fill = (hit: Hit<unknown>): void => {
    pin.vectorsInto(hit.document as Record<string, unknown>, hit.id, page.projection)
  }
  for (const hit of ranked.paginated) fill(hit)
  for (const group of ranked.groups ?? ([] as GroupResult[])) for (const hit of group.hits) fill(hit)
  return ranked
}

async function workerOrLocalFanOut(
  params: QueryParams,
  page: PageRequest,
  context: SearchContext,
  workerSearch: NonNullable<SearchContext['workerSearch']>,
): Promise<RankedFanOut | RankedPage<unknown>> {
  const scoring = scoringConfigFor(params, context)
  const viaWorker = await workerSearch(
    context.indexName,
    params,
    broadcastStatsForWorker(params, scoring),
    context.partitionIds,
    context.patternWork,
    bm25SettingFor(params, context),
    { kind: 'page', page, binding: context.cursorBinding() },
  )
  if (viaWorker?.page !== undefined) return viaWorker.page
  if (viaWorker) return viaWorker
  return localFanOut(params, context, scoring)
}

function localFanOut(
  params: QueryParams,
  context: SearchContext,
  scoring: ReturnType<typeof scoringConfigFor>,
): Promise<RankedFanOut> {
  requirePinnedState(context.pin)
  const { manager, language, config } = context
  return fanOutQuery(manager, params, language, config.schema, scoring, searchOptionsFor(params, context))
}

function rankedFanOut(shape: QueryShape, context: SearchContext): Promise<RankedFanOut | RankedPage<unknown>> {
  const { params, page, isVectorOnly, isHybridMode } = shape
  const requestedVectorField = params.vector?.field
  const hasGlobalVectorIndex =
    requestedVectorField !== undefined && vectorSearchersOf(context).has(requestedVectorField)

  if (isVectorOnly && hasGlobalVectorIndex) {
    const depth = requireCursorDepth(params.searchAfter, page.sortSignature, context.cursorBinding)
    return requireLoadedVectorCode().executeVectorSearch(
      vectorQueryHost,
      params,
      context,
      page.limit,
      page.offset,
      depth,
    )
  }
  if (isHybridMode && hasGlobalVectorIndex) {
    const depth = requireCursorDepth(params.searchAfter, page.sortSignature, context.cursorBinding)
    return hybridSearchOf(params, context, page.limit, page.offset, depth)
  }
  const workerSearch = context.workerSearch
  if (workerSearch) return workerOrLocalFanOut(params, page, context, workerSearch)
  return localFanOut(params, context, scoringConfigFor(params, context))
}

function isRankedPage(answer: RankedFanOut | RankedPage<unknown>): answer is RankedPage<unknown> {
  return 'paginated' in answer
}

async function sortedAnswer<T>(
  shape: QueryShape,
  context: SearchContext,
  pin: StatePin,
  sortSignature: string,
): Promise<RankedPage<T>> {
  const { params, page, highlighting } = shape
  requirePinnedState(pin)
  const sorted = await executeSortedQueryPage<T>(
    params,
    context,
    page.limit,
    page.offset,
    sortSignature,
    searchOptionsFor(params, context),
  )
  const ranked: RankedPage<T> = {
    paginated: sorted.hits,
    nextCursor: sorted.cursor,
    count: sorted.count,
    countExact: true,
    facets: sorted.facets,
    groups: undefined,
  }
  fillHits(ranked.paginated, undefined, params, page.projection, pin, highlighting)
  return ranked
}

function pageOfAnswer<T>(
  answer: RankedFanOut | RankedPage<unknown>,
  shape: QueryShape,
  context: SearchContext,
  pin: StatePin,
): RankedPage<T> | Promise<RankedPage<T>> {
  const { params, page, highlighting } = shape
  if (isRankedPage(answer)) return withPinnedVectors(answer as RankedPage<T>, pin, page)
  const reads: HitReads = answer.documents === undefined ? pin : copyReads(answer.documents, pin)
  const ranked = rankPage<T>(answer, params, page, context.config.schema, context.cursorBinding, reads)
  fillHits(ranked.paginated, ranked.groups, params, page.projection, reads, highlighting)
  return ranked
}

function fieldSortSignatureOf(shape: QueryShape): string | null {
  const signature = shape.page.sortSignature
  if (signature === null || !shape.hasTerm || shape.isVectorOnly || shape.isHybridMode) return null
  return sortsWithoutScores(shape.params) ? signature : null
}

function answerQuery<T>(shape: QueryShape, context: SearchContext, pin: StatePin): Promise<RankedPage<T>> {
  const fieldSortSignature = fieldSortSignatureOf(shape)
  if (fieldSortSignature !== null) return sortedAnswer<T>(shape, context, pin, fieldSortSignature)
  return rankedFanOut(shape, context).then(answer => pageOfAnswer<T>(answer, shape, context, pin))
}

export async function runQuery<T>(
  request: QueryParams,
  callerContext: QueryContext,
  pin: StatePin,
): Promise<QueryResult<T>> {
  const context = callerContext
  const { manager, config } = context
  const startTime = now()
  const limit = clampLimit(request.limit)
  const offset = clampOffset(request.offset)
  requireWithinResultWindow(limit, offset)
  const sortFields = normalizeSort(request.sort)
  requireKnownMode(request)
  const sortSignature = sortSignatureOf(request.sort)

  const hasTerm = request.term !== undefined && request.term.trim().length > 0
  const hasVector = request.vector !== undefined && request.vector.value !== undefined
  const isHybridMode = request.mode === 'hybrid' || (hasTerm && hasVector)
  const isVectorOnly = (request.mode === 'vector' || (hasVector && !hasTerm)) && !isHybridMode

  if (sortSignature !== null && (isHybridMode || request.hybrid !== undefined)) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_MODE,
      'A hybrid query cannot carry a sort, because fusion defines the order of hybrid results',
      { sort: sortFields.map(entry => entry.field) },
    )
  }

  const params = validQueryParams(request, config)
  requireVectorSearchable(params, context, isVectorOnly || isHybridMode)
  if (!isVectorOnly) requireUsablePhrases(params, context)

  const shape: QueryShape = {
    params,
    isVectorOnly,
    isHybridMode,
    hasTerm,
    page: {
      limit,
      offset,
      sortFields,
      sortSignature,
      projection: resolveProjection(params.document),
      placesPinned: context.partitionIds === undefined,
    },
    highlighting: {
      language: manager.language,
      analysis: manager.analysis,
      schema: manager.schema,
      synonyms: manager.synonyms,
    },
  }

  const ranked = await answerQuery<T>(shape, withPatternWork(context), pin)

  return {
    hits: ranked.paginated,
    count: ranked.count,
    countExact: ranked.countExact,
    elapsed: now() - startTime,
    cursor: ranked.nextCursor,
    facets: ranked.facets,
    groups: ranked.groups,
    coverage: coverageFor(manager, context.partitionIds),
  }
}
