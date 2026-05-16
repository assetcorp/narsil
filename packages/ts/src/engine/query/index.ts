import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { applyGrouping } from '../../search/grouping'
import { applyPagination } from '../../search/pagination'
import { applyPinning } from '../../search/pinning'
import { applySorting } from '../../search/sorting'
import type { GroupResult, Hit, PreflightResult, QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { clampLimit, clampOffset, now } from '../validation'
import { applyHighlights } from './highlight'
import type { QueryContext } from './shared'
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

  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  const hasVector = params.vector !== undefined && params.vector.value !== undefined
  const isHybridMode = params.mode === 'hybrid' || (hasTerm && hasVector)
  const isVectorOnly = (params.mode === 'vector' || (hasVector && !hasTerm)) && !isHybridMode

  const requestedVectorField = params.vector?.field
  const hasGlobalVectorIndex =
    requestedVectorField !== undefined && manager.getVectorIndexes().has(requestedVectorField)

  let fanOutResult: FanOutResult

  if (isVectorOnly && hasGlobalVectorIndex) {
    fanOutResult = executeVectorSearch(params, manager, config, limit, offset)
  } else if (isHybridMode && hasGlobalVectorIndex) {
    fanOutResult = await executeHybridSearch(params, manager, language, config, workerSearch, indexName, limit, offset)
  } else {
    const workerResult = workerSearch ? await workerSearch(indexName, params) : null
    if (workerResult) {
      fanOutResult = workerResult
    } else {
      const searchOptions = {
        bm25Params: config.bm25,
        stopWords: config.stopWords,
        customTokenizer: config.tokenizer,
      }
      fanOutResult = await fanOutQuery(
        manager,
        params,
        language,
        config.schema,
        { scoringMode: params.scoring ?? config.defaultScoring ?? 'local' },
        searchOptions,
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

  if (params.sort) {
    hits = applySorting(hits, params.sort, (docId: string) => manager.getRef(docId) as AnyDocument | undefined)
  }

  let groups: GroupResult[] | undefined
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

  const { paginated, nextCursor } = applyPagination(hits, limit, offset, params.searchAfter)

  for (const hit of paginated) {
    hit.document = (manager.get(hit.id) ?? {}) as T
  }

  if (groups) {
    for (const group of groups) {
      for (const hit of group.hits) {
        hit.document = (manager.get(hit.id) ?? {}) as AnyDocument
      }
    }
  }

  if (params.highlight) {
    applyHighlights(paginated, params, language, config)
  }

  const elapsed = now() - startTime

  return {
    hits: paginated,
    count: fanOutResult.totalMatched,
    elapsed,
    cursor: nextCursor,
    facets: fanOutResult.facets,
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
    const result = executeVectorSearch(params, manager, config, preflightLimit, preflightOffset)
    totalMatched = result.totalMatched
  } else if (isHybridMode && hasGlobalVectorIndex) {
    const result = await executeHybridSearch(
      params,
      manager,
      language,
      config,
      workerSearch,
      indexName,
      preflightLimit,
      preflightOffset,
    )
    totalMatched = result.totalMatched
  } else {
    const workerResult = workerSearch ? await workerSearch(indexName, params) : null
    if (workerResult) {
      totalMatched = workerResult.totalMatched
    } else {
      const searchOptions = {
        bm25Params: config.bm25,
        stopWords: config.stopWords,
        customTokenizer: config.tokenizer,
      }
      const fanOutResult = await fanOutQuery(
        manager,
        params,
        language,
        config.schema,
        { scoringMode: params.scoring ?? config.defaultScoring ?? 'local' },
        searchOptions,
      )
      totalMatched = fanOutResult.totalMatched
    }
  }

  const elapsed = now() - startTime
  return { count: totalMatched, elapsed }
}
