import type { ComparableSortValue } from '../../core/ordering'
import { resolveProjection } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { flattenSchema } from '../../schema/validator'
import { sortSignatureOf } from '../../search/cursor'
import { applyGrouping } from '../../search/grouping'
import { applyPagination, type PaginationSortContext, requireWithinResultWindow } from '../../search/pagination'
import { applyPinning } from '../../search/pinning'
import { applySorting, normalizeSort, requireSortableFields } from '../../search/sorting'
import type { FacetResult, GroupResult, Hit, PreflightResult, QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { clampLimit, clampOffset, now } from '../validation'
import { applyHighlights } from './highlight'
import { broadcastStatsForWorker, type QueryContext, scoringConfigFor, searchOptionsFor } from './shared'
import { executeSortedQueryPage, sortsWithoutScores } from './sorted'
import { executeHybridSearch, executeVectorSearch } from './vector'

export type { QueryContext } from './shared'

export async function executeQuery<T = AnyDocument>(
  params: QueryParams,
  context: QueryContext,
): Promise<QueryResult<T>> {
  const { manager, language, config, workerSearch, indexName } = context
  const startTime = now()
  const limit = clampLimit(params.limit)
  const offset = clampOffset(params.offset)
  requireWithinResultWindow(limit, offset)
  const sortFields = normalizeSort(params.sort)
  const sortSignature = sortSignatureOf(params.sort)

  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  const hasVector = params.vector !== undefined && params.vector.value !== undefined
  const isHybridMode = params.mode === 'hybrid' || (hasTerm && hasVector)
  const isVectorOnly = (params.mode === 'vector' || (hasVector && !hasTerm)) && !isHybridMode

  if (sortSignature !== null && (isHybridMode || params.hybrid !== undefined)) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_MODE,
      'A hybrid query cannot carry a sort, because fusion defines the order of hybrid results',
      { sort: sortFields.map(entry => entry.field) },
    )
  }

  requireSortableFields(params.sort, config.schema)

  let paginated: Array<Hit<T>>
  let nextCursor: string | undefined
  let count: number
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
      requestedVectorField !== undefined && manager.getVectorIndexes().has(requestedVectorField)

    let fanOutResult: FanOutResult

    if (isVectorOnly && hasGlobalVectorIndex) {
      fanOutResult = await executeVectorSearch(params, manager, config, limit, offset, context.partitionIds)
    } else if (isHybridMode && hasGlobalVectorIndex) {
      fanOutResult = await executeHybridSearch(params, context, limit, offset)
    } else {
      const scoring = scoringConfigFor(params, context)
      const workerResult = workerSearch
        ? await workerSearch(indexName, params, broadcastStatsForWorker(params, context, scoring), context.partitionIds)
        : null
      if (workerResult) {
        fanOutResult = workerResult
      } else {
        fanOutResult = await fanOutQuery(manager, params, language, config.schema, scoring, searchOptionsFor(manager))
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
    const sortKeyCache = new Map<string, readonly ComparableSortValue[]>()
    const sortKeyOf = (docId: string): readonly ComparableSortValue[] => {
      let key = sortKeyCache.get(docId)
      if (key === undefined) {
        key = manager.sortValues(docId, sortFieldNames, sortFieldTypes)
        sortKeyCache.set(docId, key)
      }
      return key
    }

    if (params.sort) {
      hits = applySorting(hits, params.sort, sortKeyOf)
    }

    if (params.group) {
      groups = applyGrouping(hits, params.group, (docId: string) => manager.getRef(docId) as AnyDocument | undefined)
    }

    if (params.pinned) {
      hits = applyPinning(hits, params.pinned, (docId: string) => {
        const doc = manager.getRef(docId)
        if (!doc) return undefined
        return { id: docId, score: 0, document: doc as T }
      })
    }

    let sortContext: PaginationSortContext | undefined
    if (sortSignature !== null) {
      sortContext = {
        signature: sortSignature,
        directions: sortFields.map(entry => entry.direction),
        sortKeyOf,
      }
    }

    const paged = applyPagination(hits, limit, offset, params.searchAfter, sortContext)
    paginated = paged.paginated
    nextCursor = paged.nextCursor
    count = fanOutResult.totalMatched
    facets = fanOutResult.facets

    if (sortSignature !== null && params.includeScores !== true) {
      for (const hit of hits) hit.score = undefined
    }
  }

  const projection = resolveProjection(params.document)

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
    applyHighlights(paginated, params, language, manager.analysis)
  }

  const elapsed = now() - startTime

  return {
    hits: paginated,
    count,
    elapsed,
    cursor: nextCursor,
    facets,
    groups,
  }
}

export async function executePreflight(params: QueryParams, context: QueryContext): Promise<PreflightResult> {
  const { manager, language, config, workerSearch, indexName } = context
  const startTime = now()

  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  const hasVector = params.vector !== undefined && params.vector.value !== undefined
  const isHybridMode = params.mode === 'hybrid' || (hasTerm && hasVector)
  const isVectorOnly = (params.mode === 'vector' || (hasVector && !hasTerm)) && !isHybridMode

  const requestedVectorField = params.vector?.field
  const hasGlobalVectorIndex =
    requestedVectorField !== undefined && manager.getVectorIndexes().has(requestedVectorField)

  let totalMatched: number

  const preflightLimit = 1000
  const preflightOffset = 0

  if (isVectorOnly && hasGlobalVectorIndex) {
    const result = await executeVectorSearch(
      params,
      manager,
      config,
      preflightLimit,
      preflightOffset,
      context.partitionIds,
    )
    totalMatched = result.totalMatched
  } else if (isHybridMode && hasGlobalVectorIndex) {
    const result = await executeHybridSearch(params, context, preflightLimit, preflightOffset)
    totalMatched = result.totalMatched
  } else {
    const scoring = scoringConfigFor(params, context)
    const workerResult = workerSearch
      ? await workerSearch(indexName, params, broadcastStatsForWorker(params, context, scoring), context.partitionIds)
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
        searchOptionsFor(manager),
      )
      totalMatched = fanOutResult.totalMatched
    }
  }

  const elapsed = now() - startTime
  return { count: totalMatched, elapsed }
}
