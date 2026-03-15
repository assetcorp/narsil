import type { PartitionIndex } from '../core/partition'
import { mergeFacets } from '../search/facets'
import { type FulltextSearchOptions, fulltextSearch } from '../search/fulltext'
import { hybridSearch } from '../search/hybrid'
import type { GlobalStatistics, InternalSearchResult, ScoredDocument } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { FacetResult } from '../types/results'
import type { SchemaDefinition, ScoringMode } from '../types/schema'
import type { QueryParams } from '../types/search'
import { collectGlobalStats } from './distributed-scoring'
import type { PartitionManager } from './manager'

export interface FanOutConfig {
  scoringMode: ScoringMode
  globalStats?: GlobalStatistics
}

export interface FanOutResult {
  scored: ScoredDocument[]
  totalMatched: number
  facets?: Record<string, FacetResult>
}

interface PartitionSearchOutcome {
  result: InternalSearchResult
  partition: PartitionIndex
}

export function fanOutQuery(
  manager: PartitionManager,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  config: FanOutConfig,
  searchOptions?: FulltextSearchOptions,
): FanOutResult {
  const partitions = manager.getAllPartitions()

  if (partitions.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  let globalStats: GlobalStatistics | undefined
  const effectiveMode = resolveEffectiveMode(config)

  if (effectiveMode === 'dfs') {
    globalStats = collectGlobalStats(manager)
  } else if (effectiveMode === 'broadcast') {
    globalStats = config.globalStats
  }

  const options = buildSearchOptions(searchOptions, globalStats)
  const outcomes = dispatchToAllPartitions(partitions, params, language, schema, options)

  const allScoredArrays = outcomes.map(o => o.result.scored)
  const merged = kWayMerge(allScoredArrays)

  let totalMatched = 0
  for (const outcome of outcomes) {
    totalMatched += outcome.result.totalMatched
  }

  let facets: Record<string, FacetResult> | undefined
  if (params.facets) {
    facets = collectAndMergeFacets(outcomes, params, schema)
  }

  return { scored: merged, totalMatched, facets }
}

function resolveEffectiveMode(config: FanOutConfig): ScoringMode {
  if (config.scoringMode === 'broadcast' && !config.globalStats) {
    return 'dfs'
  }
  return config.scoringMode
}

function buildSearchOptions(
  base: FulltextSearchOptions | undefined,
  globalStats: GlobalStatistics | undefined,
): FulltextSearchOptions {
  return {
    ...base,
    globalStats: globalStats ?? base?.globalStats,
  }
}

function dispatchToAllPartitions(
  partitions: PartitionIndex[],
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options: FulltextSearchOptions,
): PartitionSearchOutcome[] {
  const outcomes: PartitionSearchOutcome[] = []

  for (const partition of partitions) {
    const result = dispatchSinglePartition(partition, params, language, schema, options)
    outcomes.push({ result, partition })
  }

  return outcomes
}

function dispatchSinglePartition(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options: FulltextSearchOptions,
): InternalSearchResult {
  const isHybridMode = params.mode === 'hybrid'
  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  const hasVector = params.vector !== undefined

  if (isHybridMode || (hasTerm && hasVector)) {
    return hybridSearch(partition, params, language, schema, options)
  }

  if (params.mode === 'vector' || (hasVector && !hasTerm)) {
    if (!params.vector) return { scored: [], totalMatched: 0 }
    const vectorConfig = params.vector
    return partition.searchVector({
      field: vectorConfig.field,
      value: vectorConfig.value,
      k: params.limit ?? 10,
      similarity: vectorConfig.similarity,
      metric: vectorConfig.metric,
    })
  }

  return fulltextSearch(partition, params, language, schema, options)
}

function collectAndMergeFacets(
  outcomes: PartitionSearchOutcome[],
  params: QueryParams,
  schema: SchemaDefinition,
): Record<string, FacetResult> {
  const partitionFacets: Array<Record<string, FacetResult>> = []

  for (const outcome of outcomes) {
    const matchingDocIds = new Set(outcome.result.scored.map(doc => doc.docId))
    if (!params.facets) continue
    const facetResult = outcome.partition.computeFacets(matchingDocIds, params.facets, schema)
    partitionFacets.push(facetResult)
  }

  return mergeFacets(partitionFacets)
}

interface HeapNode {
  score: number
  docId: string
  partitionIdx: number
  resultIdx: number
}

export function kWayMerge(arrays: ScoredDocument[][]): ScoredDocument[] {
  const nonEmpty = arrays.filter(a => a.length > 0)

  if (nonEmpty.length === 0) return []
  if (nonEmpty.length === 1) return nonEmpty[0]

  if (nonEmpty.length <= 4) {
    return sequentialMerge(nonEmpty)
  }

  return heapMerge(nonEmpty)
}

function sequentialMerge(arrays: ScoredDocument[][]): ScoredDocument[] {
  let merged = arrays[0]

  for (let i = 1; i < arrays.length; i++) {
    merged = mergeTwoSorted(merged, arrays[i])
  }

  return merged
}

function mergeTwoSorted(a: ScoredDocument[], b: ScoredDocument[]): ScoredDocument[] {
  const result: ScoredDocument[] = new Array(a.length + b.length)
  let ai = 0
  let bi = 0
  let ri = 0

  while (ai < a.length && bi < b.length) {
    if (a[ai].score > b[bi].score || (a[ai].score === b[bi].score && a[ai].docId <= b[bi].docId)) {
      result[ri++] = a[ai++]
    } else {
      result[ri++] = b[bi++]
    }
  }

  while (ai < a.length) {
    result[ri++] = a[ai++]
  }

  while (bi < b.length) {
    result[ri++] = b[bi++]
  }

  return result
}

function heapMerge(arrays: ScoredDocument[][]): ScoredDocument[] {
  const heap: HeapNode[] = []
  let totalSize = 0

  for (let i = 0; i < arrays.length; i++) {
    if (arrays[i].length > 0) {
      totalSize += arrays[i].length
      heapPush(heap, {
        score: arrays[i][0].score,
        docId: arrays[i][0].docId,
        partitionIdx: i,
        resultIdx: 0,
      })
    }
  }

  const result: ScoredDocument[] = new Array(totalSize)
  let writeIdx = 0

  while (heap.length > 0) {
    const top = heapPop(heap)
    result[writeIdx++] = arrays[top.partitionIdx][top.resultIdx]

    const nextIdx = top.resultIdx + 1
    if (nextIdx < arrays[top.partitionIdx].length) {
      const nextDoc = arrays[top.partitionIdx][nextIdx]
      heapPush(heap, {
        score: nextDoc.score,
        docId: nextDoc.docId,
        partitionIdx: top.partitionIdx,
        resultIdx: nextIdx,
      })
    }
  }

  return result
}

function heapNodeGreater(a: HeapNode, b: HeapNode): boolean {
  if (a.score !== b.score) return a.score > b.score
  return a.docId < b.docId
}

function heapPush(heap: HeapNode[], node: HeapNode): void {
  heap.push(node)
  let idx = heap.length - 1

  while (idx > 0) {
    const parentIdx = (idx - 1) >> 1
    if (heapNodeGreater(heap[idx], heap[parentIdx])) {
      const tmp = heap[idx]
      heap[idx] = heap[parentIdx]
      heap[parentIdx] = tmp
      idx = parentIdx
    } else {
      break
    }
  }
}

function heapPop(heap: HeapNode[]): HeapNode {
  const top = heap[0]
  const last = heap.pop() as HeapNode

  if (heap.length > 0) {
    heap[0] = last
    let idx = 0

    while (true) {
      const left = 2 * idx + 1
      const right = 2 * idx + 2
      let largest = idx

      if (left < heap.length && heapNodeGreater(heap[left], heap[largest])) {
        largest = left
      }
      if (right < heap.length && heapNodeGreater(heap[right], heap[largest])) {
        largest = right
      }

      if (largest !== idx) {
        const tmp = heap[idx]
        heap[idx] = heap[largest]
        heap[largest] = tmp
        idx = largest
      } else {
        break
      }
    }
  }

  return top
}
