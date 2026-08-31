import type { PartitionIndex } from '../../core/partition'
import { pruneStatsToQueryTerms } from '../../partitioning/distributed-scoring'
import type { FanOutConfig, FanOutResult } from '../../partitioning/fan-out'
import type { PartitionManager } from '../../partitioning/manager'
import { partitionsIn } from '../../partitioning/partition-selection'
import type { FulltextSearchOptions } from '../../search/fulltext'
import type { GlobalStatistics, ScoredDocument } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { QueryCoverage } from '../../types/results'
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
    partitionIds?: number[],
  ) => Promise<FanOutResult | null>
  indexName: string
  broadcastStats?: (indexName: string) => GlobalStatistics | undefined
  partitionIds?: number[]
  cursorBinding: string
}

export function partitionsFor(manager: PartitionManager, partitionIds: number[] | undefined): PartitionIndex[] {
  return partitionsIn(manager, partitionIds)
}

/**
 * Reports how much of an index one local search read.
 *
 * `totalPartitions` counts the partitions the search should have read, so a
 * search confined to a few of them counts those few. Nothing times out on a
 * single engine, and a named partition the manager does not hold is the one
 * way a local search can fail to read one.
 *
 * @param manager - The partition manager holding the documents.
 * @param partitionIds - The partitions the search was confined to, or
 * undefined where it read the whole index.
 * @returns The four figures a caller reads as {@link QueryResult.coverage}.
 */
export function coverageFor(manager: PartitionManager, partitionIds: number[] | undefined): QueryCoverage {
  if (partitionIds === undefined) {
    return {
      totalPartitions: manager.partitionCount,
      queriedPartitions: manager.partitionCount,
      timedOutPartitions: 0,
      failedPartitions: 0,
    }
  }
  const queriedPartitions = partitionsFor(manager, partitionIds).length
  return {
    totalPartitions: partitionIds.length,
    queriedPartitions,
    timedOutPartitions: 0,
    failedPartitions: partitionIds.length - queriedPartitions,
  }
}

/**
 * Works out which partitions a vector search may answer from.
 *
 * The vector index records the partition of every vector it stores, so a
 * search reads its own membership rather than a list of document ids. A vector
 * the index stored before it tracked partitions carries none. This fills those
 * in from the manager first, so every later search reads the membership the
 * index already holds.
 *
 * @param manager - The partition manager holding the documents.
 * @param vecIndex - The vector index the search runs against.
 * @param partitionIds - The partitions the search may answer from, or
 * undefined to search the whole index.
 * @returns The partitions to confine the search to, or undefined where the
 * caller named none.
 */
export function partitionsForVectorSearch(
  manager: PartitionManager,
  vecIndex: VectorIndex,
  partitionIds: number[] | undefined,
): ReadonlySet<number> | undefined {
  if (partitionIds === undefined) {
    return undefined
  }
  if (!vecIndex.partitionsKnown()) {
    vecIndex.assignPartitions(docId => manager.partitionIdOf(docId))
  }
  return new Set(partitionIds)
}

export function scoringConfigFor(params: QueryParams, context: QueryContext): FanOutConfig {
  const scoringMode = params.scoring ?? context.config.defaultScoring ?? 'local'
  if (scoringMode !== 'broadcast') {
    return { scoringMode, partitionIds: context.partitionIds }
  }
  return { scoringMode, globalStats: context.broadcastStats?.(context.indexName), partitionIds: context.partitionIds }
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
  partitionIds?: number[],
): Set<string> {
  const filterDocIds = new Set<string>()
  if (!params.filters) return filterDocIds
  for (const partition of partitionsFor(manager, partitionIds)) {
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
