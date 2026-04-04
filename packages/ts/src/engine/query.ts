import { tokenize } from '../core/tokenizer'
import { highlightField } from '../highlighting/highlighter'
import { type FanOutResult, fanOutQuery } from '../partitioning/fan-out'
import type { PartitionManager } from '../partitioning/manager'
import { linearCombination, reciprocalRankFusion } from '../search/fusion'
import { applyGrouping } from '../search/grouping'
import { applyPagination } from '../search/pagination'
import { applyPinning } from '../search/pinning'
import { applySorting } from '../search/sorting'
import type { ScoredDocument } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { GroupResult, HighlightMatch, Hit, PreflightResult, QueryResult } from '../types/results'
import type { AnyDocument, IndexConfig } from '../types/schema'
import type { QueryParams } from '../types/search'
import type { VectorIndex, VectorScoredResult } from '../vector/vector-index'
import { clampLimit, clampOffset, now } from './validation'

interface QueryContext {
  manager: PartitionManager
  language: LanguageModule
  config: IndexConfig
  workerSearch?: (indexName: string, params: QueryParams) => Promise<FanOutResult | null>
  indexName: string
}

function collectFilterDocIds(
  manager: PartitionManager,
  params: QueryParams,
  schema: IndexConfig['schema'],
): Set<string> {
  const filterDocIds = new Set<string>()
  if (!params.filters) return filterDocIds
  for (const partition of manager.getAllPartitions()) {
    const partitionFiltered = partition.applyFilters(params.filters, schema)
    for (const docId of partitionFiltered) {
      filterDocIds.add(docId)
    }
  }
  return filterDocIds
}

function vectorResultsToScored(results: VectorScoredResult[]): ScoredDocument[] {
  return results.map(r => ({
    docId: r.docId,
    score: r.score,
    termFrequencies: {},
    fieldLengths: {},
    idf: {},
  }))
}

function resolveVectorIndex(manager: PartitionManager, fieldName: string): VectorIndex | undefined {
  return manager.getVectorIndexes().get(fieldName)
}

function executeVectorSearch(
  params: QueryParams,
  manager: PartitionManager,
  config: IndexConfig,
  limit: number,
  offset: number,
): FanOutResult {
  const vectorConfig = params.vector
  if (!vectorConfig || !vectorConfig.value) {
    return { scored: [], totalMatched: 0 }
  }

  const vecIndex = resolveVectorIndex(manager, vectorConfig.field)
  if (!vecIndex) {
    return { scored: [], totalMatched: 0 }
  }

  let filterDocIds: Set<string> | undefined
  if (params.filters) {
    filterDocIds = collectFilterDocIds(manager, params, config.schema)
    if (filterDocIds.size === 0) {
      return { scored: [], totalMatched: 0 }
    }
  }

  const queryVec = new Float32Array(vectorConfig.value)
  const k = limit + offset + 1
  const results = vecIndex.search(queryVec, k, {
    metric: vectorConfig.metric ?? 'cosine',
    minSimilarity: vectorConfig.similarity ?? 0,
    filterDocIds,
    efSearch: vectorConfig.efSearch,
  })

  const scored = vectorResultsToScored(results)
  return { scored, totalMatched: scored.length }
}

async function executeHybridSearch(
  params: QueryParams,
  manager: PartitionManager,
  language: LanguageModule,
  config: IndexConfig,
  workerSearch: QueryContext['workerSearch'],
  indexName: string,
  limit: number,
  offset: number,
): Promise<FanOutResult> {
  const { vector: _vector, mode: _mode, hybrid: _hybrid, ...textOnlyParams } = params

  let filterDocIds: Set<string> | undefined
  if (params.filters) {
    filterDocIds = collectFilterDocIds(manager, params, config.schema)
    if (filterDocIds.size === 0) {
      return { scored: [], totalMatched: 0 }
    }
  }

  let textFanOutResult: FanOutResult
  const textWorkerResult = workerSearch ? await workerSearch(indexName, textOnlyParams) : null
  if (textWorkerResult) {
    textFanOutResult = textWorkerResult
  } else {
    const searchOptions = {
      bm25Params: config.bm25,
      stopWords: config.stopWords,
      customTokenizer: config.tokenizer,
    }
    textFanOutResult = await fanOutQuery(
      manager,
      textOnlyParams,
      language,
      config.schema,
      { scoringMode: params.scoring ?? config.defaultScoring ?? 'local' },
      searchOptions,
    )
  }

  const vectorConfig = params.vector
  if (!vectorConfig || !vectorConfig.value) {
    return {
      scored: textFanOutResult.scored,
      totalMatched: textFanOutResult.totalMatched,
      facets: textFanOutResult.facets,
    }
  }

  let vectorScored: ScoredDocument[] = []
  const vecIndex = resolveVectorIndex(manager, vectorConfig.field)
  if (vecIndex) {
    const queryVec = new Float32Array(vectorConfig.value)
    const vectorK = limit + offset + 1
    const vectorResults = vecIndex.search(queryVec, vectorK, {
      metric: vectorConfig.metric ?? 'cosine',
      minSimilarity: vectorConfig.similarity ?? 0,
      filterDocIds,
      efSearch: vectorConfig.efSearch,
    })
    vectorScored = vectorResultsToScored(vectorResults)
  }

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

  if (filterDocIds) {
    fusedScored = fusedScored.filter(doc => filterDocIds.has(doc.docId))
  }

  return {
    scored: fusedScored,
    totalMatched: fusedScored.length,
    facets: textFanOutResult.facets,
  }
}

function clampAlpha(alpha: number | undefined): number {
  if (alpha === undefined) return 0.5
  if (!Number.isFinite(alpha)) return 0.5
  if (alpha < 0) return 0
  if (alpha > 1) return 1
  return alpha
}

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
