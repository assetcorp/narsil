import type { FanOutResult } from '../../partitioning/fan-out'
import type { PartitionManager } from '../../partitioning/manager'
import type { ScoredDocument } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { VectorIndex, VectorScoredResult } from '../../vector/vector-index'

export interface QueryContext {
  manager: PartitionManager
  language: LanguageModule
  config: IndexConfig
  workerSearch?: (indexName: string, params: QueryParams) => Promise<FanOutResult | null>
  indexName: string
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
