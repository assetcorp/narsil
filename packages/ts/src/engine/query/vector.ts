import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import type { PartitionManager } from '../../partitioning/manager'
import { linearCombination, reciprocalRankFusion } from '../../search/fusion'
import type { ScoredDocument } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { clampAlpha, collectFilterDocIds, type QueryContext, resolveVectorIndex, vectorResultsToScored } from './shared'

export function executeVectorSearch(
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

export async function executeHybridSearch(
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
