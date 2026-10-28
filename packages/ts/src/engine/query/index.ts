import type { ComparableSortValue } from '../../core/ordering'
import { projectionKeepsField, resolveProjection } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { countsWithoutScores, fanOutMatchCount } from '../../partitioning/match-count'
import { flattenSchema } from '../../schema/validator'
import { decodePageCursor, requireMatchingCursor, sortSignatureOf } from '../../search/cursor'
import { applyGrouping } from '../../search/grouping'
import { applyPagination, type PaginationSortContext, requireWithinResultWindow } from '../../search/pagination'
import { placePinned } from '../../search/pinning'
import { applySorting, normalizeSort, sortModesOf } from '../../search/sorting'
import type { FacetResult, GroupResult, Hit, PreflightResult, QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { clampLimit, clampOffset, now } from '../validation'
import { applyHighlights } from './highlight'
import type { FixedDepthHybrid, searchFixedDepthHybrid } from './hybrid-depth'
import { runtimeHost } from './runtime-host'
import {
  broadcastStatsForWorker,
  coverageFor,
  type QueryContext,
  requireKnownMode,
  requireVectorSearchable,
  scoringConfigFor,
  searchOptionsFor,
  validQueryParams,
  vectorSearchersOf,
  withPatternWork,
} from './shared'
import { executeSortedQueryPage, sortsWithoutScores } from './sorted'
import { executeHybridSearch, executeVectorSearch } from './vector'

export type { QueryContext } from './shared'

function requireCursorDepth(cursor: string | undefined, signature: string | null, binding: string): number {
  if (cursor === undefined) return 0
  const decoded = decodePageCursor(cursor)
  requireMatchingCursor(decoded, cursor, signature, true, binding)
  return decoded.depth ?? 0
}

export async function executeQuery<T = AnyDocument>(
  request: QueryParams,
  callerContext: QueryContext,
): Promise<QueryResult<T>> {
  if (request.rerank === undefined && (request.hybrid?.depth ?? null) === null) {
    return runQuery<T>(request, callerContext, undefined)
  }
  const runtime = await import('../../rerank/runtime')
  if (request.rerank !== undefined) {
    return runtime.executeRerankedQuery<T>(request, callerContext, executeQuery<T>, runtimeHost)
  }
  return runQuery<T>(request, callerContext, runtime.searchFixedDepthHybrid)
}

async function runQuery<T>(
  request: QueryParams,
  callerContext: QueryContext,
  searchFixedDepth: typeof searchFixedDepthHybrid | undefined,
): Promise<QueryResult<T>> {
  const context = withPatternWork(callerContext)
  const { manager, language, config, workerSearch, indexName } = context
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
  const projection = resolveProjection(params.document)

  let paginated: Array<Hit<T>>
  let nextCursor: string | undefined
  let count: number
  let countExact = true
  let facets: Record<string, FacetResult> | undefined
  let groups: GroupResult[] | undefined

  if (sortSignature !== null && hasTerm && !isVectorOnly && !isHybridMode && sortsWithoutScores(params)) {
    const page = executeSortedQueryPage<T>(params, context, limit, offset, sortSignature)
    paginated = page.hits
    nextCursor = page.cursor
    count = page.count
    facets = page.facets
  } else {
    const requestedVectorField = params.vector?.field
    const hasGlobalVectorIndex =
      requestedVectorField !== undefined && vectorSearchersOf(context).has(requestedVectorField)

    let fanOutResult: FanOutResult
    let pageFixedDepth: FixedDepthHybrid['page'] | undefined

    if (isVectorOnly && hasGlobalVectorIndex) {
      const depth = requireCursorDepth(params.searchAfter, sortSignature, context.cursorBinding)
      fanOutResult = await executeVectorSearch(params, context, limit, offset, depth)
    } else if (isHybridMode && hasGlobalVectorIndex) {
      const depth = requireCursorDepth(params.searchAfter, sortSignature, context.cursorBinding)
      if (searchFixedDepth === undefined) {
        fanOutResult = await executeHybridSearch(params, context, limit, offset, depth)
      } else {
        const fixed = await searchFixedDepth(params, context, { cursorDepth: depth, offset, limit }, runtimeHost)
        fanOutResult = fixed.result
        pageFixedDepth = fixed.page
      }
    } else {
      const scoring = scoringConfigFor(params, context)
      const workerResult = workerSearch
        ? await workerSearch(
            indexName,
            params,
            broadcastStatsForWorker(params, context, scoring),
            context.partitionIds,
            context.patternWork,
          )
        : null
      if (workerResult) {
        fanOutResult = workerResult
      } else {
        fanOutResult = await fanOutQuery(
          manager,
          params,
          language,
          config.schema,
          scoring,
          searchOptionsFor(manager, context.patternWork),
        )
      }
    }

    const needsFullHits =
      params.sort !== undefined ||
      params.group !== undefined ||
      params.pinned !== undefined ||
      params.searchAfter !== undefined
    let hits: Array<Hit<T>>

    if (needsFullHits) {
      hits = fanOutResult.scored.map(scored => ({
        id: scored.docId,
        score: scored.score,
        document: undefined as unknown as T,
        scoreComponents: params.includeScoreComponents
          ? { termFrequencies: scored.termFrequencies, fieldLengths: scored.fieldLengths, idf: scored.idf }
          : undefined,
      }))
    } else {
      const end = Math.min(offset + limit + 1, fanOutResult.scored.length)
      hits = new Array(end)
      for (let i = 0; i < end; i++) {
        const scored = fanOutResult.scored[i]
        hits[i] = {
          id: scored.docId,
          score: scored.score,
          document: undefined as unknown as T,
          scoreComponents: params.includeScoreComponents
            ? { termFrequencies: scored.termFrequencies, fieldLengths: scored.fieldLengths, idf: scored.idf }
            : undefined,
        }
      }
    }

    const sortFieldNames = sortFields.map(entry => entry.field)
    const sortFlatSchema = sortFieldNames.length === 0 ? {} : flattenSchema(config.schema)
    const sortFieldTypes = sortFieldNames.map(field => sortFlatSchema[field])
    const sortModes = sortModesOf(sortFields)
    const sortKeyCache = new Map<string, readonly ComparableSortValue[]>()
    const sortKeyOf = (docId: string): readonly ComparableSortValue[] => {
      let key = sortKeyCache.get(docId)
      if (key === undefined) {
        key = manager.sortValues(docId, sortFieldNames, sortFieldTypes, sortModes)
        sortKeyCache.set(docId, key)
      }
      return key
    }

    if (params.sort) {
      hits = applySorting(hits, params.sort, sortKeyOf)
    }

    if (params.group) {
      groups = applyGrouping(hits, params.group, {
        fieldValues: (docId, fieldPaths) => manager.fieldValues(docId, fieldPaths),
        document: docId => manager.getRef(docId),
      })
    }

    const organic = hits
    let pinsFromOutside = 0
    if (params.pinned && params.searchAfter === undefined && context.partitionIds === undefined) {
      const placement = placePinned(hits, params.pinned, (docId: string) => {
        const doc = manager.getRef(docId)
        if (!doc) return undefined
        return { id: docId, score: 0, document: doc as T }
      })
      hits = placement.hits
      pinsFromOutside = placement.placedFromOutside
    }

    let sortContext: PaginationSortContext | undefined
    if (sortSignature !== null) {
      sortContext = {
        signature: sortSignature,
        directions: sortFields.map(entry => entry.direction),
        sortKeyOf,
      }
    }

    const pinnedIds =
      params.pinned !== undefined && params.searchAfter === undefined
        ? new Set(params.pinned.map(entry => entry.docId))
        : undefined
    if (pageFixedDepth === undefined) {
      const paged = applyPagination(
        hits,
        limit,
        offset,
        context.cursorBinding,
        params.searchAfter,
        sortContext,
        pinnedIds,
      )
      paginated = paged.paginated
      nextCursor = paged.nextCursor
    } else {
      const paged = pageFixedDepth(hits, organic, context.partitionIds === undefined ? pinnedIds : undefined)
      paginated = paged.page
      nextCursor = paged.cursor
    }
    const holdsEveryMatch =
      fanOutResult.matchedExact !== false && fanOutResult.scored.length === fanOutResult.totalMatched
    count = fanOutResult.totalMatched + (holdsEveryMatch ? pinsFromOutside : 0)
    countExact = fanOutResult.matchedExact !== false && (holdsEveryMatch || pinsFromOutside === 0)
    facets = fanOutResult.facets

    if (sortSignature !== null && params.includeScores !== true) {
      for (const hit of hits) hit.score = undefined
    }
  }

  if (projection.kind === 'none') {
    for (const hit of paginated) {
      hit.document = {} as T
    }
  } else {
    for (const hit of paginated) {
      hit.document = (manager.get(hit.id, projection) ?? {}) as T
    }
  }

  if (groups) {
    for (const group of groups) {
      for (const hit of group.hits) {
        if (projection.kind === 'none') {
          hit.document = {}
          continue
        }
        hit.document = manager.get(hit.id, projection) ?? {}
      }
    }
  }

  if (params.highlight) {
    const dropped = params.highlight.fields.some(field => !projectionKeepsField(projection, field))
    const readStoredDocument = dropped
      ? (docId: string): Record<string, unknown> | undefined => manager.get(docId, { kind: 'full' })
      : undefined
    applyHighlights(paginated, params, language, manager.analysis, manager.schema, readStoredDocument, manager.synonyms)
  }

  const elapsed = now() - startTime

  return {
    hits: paginated,
    count,
    countExact,
    elapsed,
    cursor: nextCursor,
    facets,
    groups,
    coverage: coverageFor(manager, context.partitionIds),
  }
}

export async function executePreflight(request: QueryParams, callerContext: QueryContext): Promise<PreflightResult> {
  const context = withPatternWork(callerContext)
  const { manager, language, config, workerSearch, indexName } = context
  const startTime = now()

  requireKnownMode(request)
  const params = validQueryParams(request, config)
  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  const hasVector = params.vector !== undefined && params.vector.value !== undefined
  const isHybridMode = params.mode === 'hybrid' || (hasTerm && hasVector)
  const isVectorOnly = (params.mode === 'vector' || (hasVector && !hasTerm)) && !isHybridMode

  requireVectorSearchable(params, context, isVectorOnly || isHybridMode)

  const requestedVectorField = params.vector?.field
  const hasGlobalVectorIndex =
    requestedVectorField !== undefined && vectorSearchersOf(context).has(requestedVectorField)

  let totalMatched: number
  let countExact = true

  const preflightLimit = 1000
  const preflightOffset = 0

  if (isVectorOnly && hasGlobalVectorIndex) {
    const result = await executeVectorSearch(params, context, preflightLimit, preflightOffset)
    totalMatched = result.totalMatched
    countExact = result.matchedExact !== false
  } else if (isHybridMode && hasGlobalVectorIndex) {
    let result: FanOutResult
    if ((params.hybrid?.depth ?? null) === null) {
      result = await executeHybridSearch(params, context, preflightLimit, preflightOffset)
    } else {
      const { searchFixedDepthHybrid } = await import('../../rerank/runtime')
      const window = { cursorDepth: 0, offset: 0, limit: 0 }
      result = (await searchFixedDepthHybrid(params, context, window, runtimeHost)).result
    }
    totalMatched = result.totalMatched
    countExact = result.matchedExact !== false
  } else if (countsWithoutScores(params)) {
    totalMatched = fanOutMatchCount(manager, params, language, config.schema, {
      searchOptions: searchOptionsFor(manager, context.patternWork),
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
        searchOptionsFor(manager, context.patternWork),
      )
      totalMatched = fanOutResult.totalMatched
    }
  }

  const elapsed = now() - startTime
  return { count: totalMatched, countExact, elapsed }
}
