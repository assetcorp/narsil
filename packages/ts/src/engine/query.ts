import { tokenize } from '../core/tokenizer'
import { ErrorCodes, NarsilError } from '../errors'
import { highlightField } from '../highlighting/highlighter'
import { fanOutQuery } from '../partitioning/fan-out'
import type { PartitionManager } from '../partitioning/manager'
import { applyGrouping } from '../search/grouping'
import { applyPagination } from '../search/pagination'
import { applyPinning } from '../search/pinning'
import { applySorting } from '../search/sorting'
import type { LanguageModule } from '../types/language'
import type { GroupResult, HighlightMatch, Hit, PreflightResult, QueryResult } from '../types/results'
import type { AnyDocument, IndexConfig } from '../types/schema'
import type { QueryParams } from '../types/search'
import { clampLimit, clampOffset, now } from './validation'

interface QueryContext {
  manager: PartitionManager
  language: LanguageModule
  config: IndexConfig
}

export async function executeQuery<T = AnyDocument>(
  indexName: string,
  params: QueryParams,
  context: QueryContext,
): Promise<QueryResult<T>> {
  const { manager, language, config } = context
  const startTime = now()
  const limit = clampLimit(params.limit)
  const offset = clampOffset(params.offset)

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

  let hits: Array<Hit<T>> = fanOutResult.scored.map(scored => ({
    id: scored.docId,
    score: scored.score,
    document: undefined as unknown as T,
    scoreComponents: {
      termFrequencies: scored.termFrequencies,
      fieldLengths: scored.fieldLengths,
      idf: scored.idf,
    },
  }))

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

export async function executePreflight(
  indexName: string,
  params: QueryParams,
  context: QueryContext,
): Promise<PreflightResult> {
  const { manager, language, config } = context
  const startTime = now()

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

  const elapsed = now() - startTime
  return { count: fanOutResult.totalMatched, elapsed }
}

function applyHighlights<T>(
  hits: Array<Hit<T>>,
  params: QueryParams,
  language: LanguageModule,
  config: IndexConfig,
): void {
  if (!params.highlight) return

  const queryTokenResult = tokenize(params.term ?? '', language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: config.tokenizer,
    stopWordOverride: config.stopWords,
  })

  for (const hit of hits) {
    const highlights: Record<string, HighlightMatch> = {}
    for (const field of params.highlight.fields) {
      const doc = hit.document as Record<string, unknown>
      const fieldValue = doc[field]
      if (typeof fieldValue === 'string') {
        highlights[field] = highlightField(fieldValue, queryTokenResult.tokens, language, {
          preTag: params.highlight.preTag,
          postTag: params.highlight.postTag,
          maxSnippetLength: params.highlight.maxSnippetLength,
        })
      }
    }
    hit.highlights = highlights
  }
}
