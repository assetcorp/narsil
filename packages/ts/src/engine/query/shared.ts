import { pruneStatsToQueryTerms } from '../../partitioning/distributed-scoring'
import type { FanOutConfig, FanOutResult } from '../../partitioning/fan-out'
import type { PartitionManager } from '../../partitioning/manager'
import type { FulltextSearchOptions } from '../../search/fulltext'
import type { GlobalStatistics, ScoredDocument } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { VectorIndex, VectorScoredResult } from '../../vector/vector-index'

export interface QueryContext {
  manager: PartitionManager
  language: LanguageModule
  config: IndexConfig
  workerSearch?: (
    indexName: string,
    params: QueryParams,
    globalStats?: GlobalStatistics,
  ) => Promise<FanOutResult | null>
  indexName: string
  broadcastStats?: (indexName: string) => GlobalStatistics | undefined
}

export function scoringConfigFor(params: QueryParams, context: QueryContext): FanOutConfig {
  const scoringMode = params.scoring ?? context.config.defaultScoring ?? 'local'
  if (scoringMode !== 'broadcast') {
    return { scoringMode }
  }
  return { scoringMode, globalStats: context.broadcastStats?.(context.indexName) }
}

export function broadcastStatsForWorker(
  params: QueryParams,
  context: QueryContext,
  scoring: FanOutConfig,
): GlobalStatistics | undefined {
  if (scoring.scoringMode !== 'broadcast' || scoring.globalStats === undefined) {
    return undefined
  }
  const term = params.term
  if (term === undefined || term.trim().length === 0) {
    return undefined
  }
  return pruneStatsToQueryTerms(scoring.globalStats, term, context.language, context.manager.analysis)
}

export function searchOptionsFor(manager: PartitionManager): FulltextSearchOptions {
  return {
    bm25Params: manager.config.bm25,
    stopWords: manager.analysis.stopWords,
    customTokenizer: manager.analysis.customTokenizer,
  }
}

export function collectFilterDocIds(
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

export function vectorResultsToScored(results: VectorScoredResult[]): ScoredDocument[] {
  return results.map(r => ({
    docId: r.docId,
    score: r.score,
    termFrequencies: {},
    fieldLengths: {},
    idf: {},
  }))
}

export function resolveVectorIndex(manager: PartitionManager, fieldName: string): VectorIndex | undefined {
  return manager.getVectorIndexes().get(fieldName)
}

export function clampAlpha(alpha: number | undefined): number {
  if (alpha === undefined) return 0.5
  if (!Number.isFinite(alpha)) return 0.5
  if (alpha < 0) return 0
  if (alpha > 1) return 1
  return alpha
}
