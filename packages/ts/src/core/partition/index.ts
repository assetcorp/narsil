import { ErrorCodes, NarsilError } from '../../errors'
import { computeFacets } from '../../search/facets'
import type { FilterExpression } from '../../types/filters'
import type {
  GlobalStatistics,
  InternalSearchParams,
  InternalSearchResult,
  ScoredDocument,
  SerializablePartition,
} from '../../types/internal'
import type { FacetResult } from '../../types/results'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { createDocumentStore } from '../document-store'
import { createInvertedIndex } from '../inverted-index'
import type { PatternWorkMeter } from '../pattern-index/types'
import { cloneProjected, type ResolvedProjection } from '../projection'
import { createPartitionStats } from '../statistics'
import { discardStoredValues } from '../stored-values/columns'
import { createSurfaceRegistry } from '../surface-registry'
import type { FacetMatchSet } from './facets'
import type { PartitionFilterMatches } from './filters'
import { applyPartitionFilters, applyPartitionFiltersBitset, partitionFilterMatches } from './filters'
import { discardKeywordSegment, keywordBatch } from './keyword-writes'
import { type PartitionSearchMatches, searchFulltextMatches } from './matches'
import { estimatePartitionBytes } from './memory'
import { createPartitionMutations } from './mutations'
import { createGrowingPartialWords, expandPartialWords } from './partial-words/registry'
import type { PartialWordAnalysis } from './partial-words/spellings'
import type { AddedWord, PartialWordRequest } from './partial-words/types'
import type { PartitionIndex } from './partition-index'
import type { PartitionReadState } from './read-state'
import { searchFulltext } from './search'
import { encodeSegmentState, mergeSegmentPayload, type SegmentPayload } from './segment-payload'
import { refreshSortColumns, sortedReadsOf } from './sorting'
import { expandTermPrefix, suggestDisplayTerms } from './suggestion-code'
import type { PartitionSuggestion } from './suggestions'
import { getNestedValue, type PartitionInsertOptions, type PartitionState } from './utils'

export type { GlobalStatistics, InternalSearchParams, InternalSearchResult, ScoredDocument }
export type { PartitionInsertOptions }
export type { FacetMatchSet, FacetOrdinalSet } from './facets'
export type { PartitionFilterMatches } from './filters'
export type { PartitionSearchMatches } from './matches'
export type { PartitionIndex } from './partition-index'
export type { SortedPageEntry, SortPageRequest } from './sorting'
export type { PartitionSuggestion } from './suggestions'

const statesByPartition = new WeakMap<PartitionIndex, PartitionState>()

function readSegmentState(segment: PartitionIndex): PartitionState {
  const state = statesByPartition.get(segment)
  if (state === undefined) {
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The segment did not come from this engine', {})
  }
  return state
}

export function partitionStateOf(partition: PartitionIndex): PartitionState {
  return readSegmentState(partition)
}

export function createPartitionIndex(partitionId: number, trackPositions = true): PartitionIndex {
  const fieldNameTable = { names: [] as string[], indexMap: new Map<string, number>() }
  const docStore = createDocumentStore()

  const state: PartitionState = {
    invertedIdx: createInvertedIndex(fieldNameTable),
    docStore,
    stats: createPartitionStats(into => state.invertedIdx.addDocumentFrequencies(into)),
    surfaceRegistry: createSurfaceRegistry(),
    numericIndexes: new Map(),
    booleanIndexes: new Map(),
    enumIndexes: new Map(),
    geoIndexes: new Map(),
    patternIndexes: new Map(),
    sizeIndexes: new Map(),
    fieldNameTable,
    partialWords: createGrowingPartialWords({ docStore }),
    flatSchemaCache: null,
    lastSchemaRef: null,
    trackPositions,
    sortColumns: null,
    scoreBuffer: null,
    vectorOrdinalMaps: null,
  }

  function clearAll(): void {
    state.surfaceRegistry.clear()
    state.partialWords.clear()
    discardKeywordSegment(state)
    discardStoredValues(state.docStore)
    state.invertedIdx.clear()
    state.docStore.clear()
    for (const idx of state.numericIndexes.values()) idx.clear()
    for (const idx of state.booleanIndexes.values()) idx.clear()
    for (const idx of state.enumIndexes.values()) idx.clear()
    for (const idx of state.geoIndexes.values()) idx.clear()
    state.numericIndexes.clear()
    state.booleanIndexes.clear()
    state.enumIndexes.clear()
    state.geoIndexes.clear()
    state.patternIndexes.clear()
    state.sizeIndexes.clear()
    state.stats.deserialize({ totalDocuments: 0, totalFieldLengths: {}, averageFieldLengths: {}, docFrequencies: {} })
    state.flatSchemaCache = null
    state.lastSchemaRef = null
    state.sortColumns = null
    state.scoreBuffer = null
    state.vectorOrdinalMaps = null
  }

  const partition: PartitionIndex = {
    get partitionId() {
      return partitionId
    },
    get stats() {
      return state.stats
    },

    ...createPartitionMutations(state, partitionId),

    beginBatch(): void {
      keywordBatch(state, false)
    },

    endBatch(): void {
      keywordBatch(state, true)
      state.invertedIdx.endBatch()
      refreshSortColumns(state)
    },

    encodeSegment(): SegmentPayload {
      return encodeSegmentState(state)
    },

    mergeSegmentPayload(payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void {
      mergeSegmentPayload(state, payload, documents)
    },

    get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined {
      const stored = state.docStore.get(docId)
      if (!stored) return undefined
      return cloneProjected(stored.fields, projection)
    },

    getRef(docId: string): AnyDocument | undefined {
      const stored = state.docStore.get(docId)
      if (!stored) return undefined
      return stored.fields as AnyDocument
    },

    fieldValues(docId: string, fieldPaths: readonly string[]): unknown[] | undefined {
      const stored = state.docStore.get(docId)
      if (!stored) return undefined
      return fieldPaths.map(fieldPath => getNestedValue(stored.fields as Record<string, unknown>, fieldPath))
    },

    has(docId: string): boolean {
      return state.docStore.has(docId)
    },

    count(): number {
      return state.docStore.count()
    },

    *docIds(): IterableIterator<string> {
      for (const [id] of state.docStore.all()) {
        yield id
      }
    },

    sortedDocIds(): readonly string[] {
      return state.docStore.sortedDocIds()
    },

    releaseSortedDocIds(): void {
      state.docStore.releaseSortedDocIds()
    },

    clear: clearAll,

    estimateMemoryBytes(): number {
      return estimatePartitionBytes(state)
    },

    readStates(): readonly PartitionReadState[] {
      return [state]
    },

    searchFulltext(params: InternalSearchParams): InternalSearchResult {
      return searchFulltext(state, params)
    },

    searchFulltextMatches(params: InternalSearchParams): PartitionSearchMatches {
      return searchFulltextMatches(state, params)
    },

    ...sortedReadsOf(state),

    applyFilters(filters: FilterExpression, schema: SchemaDefinition, meter: PatternWorkMeter): Set<string> {
      return applyPartitionFilters(state, filters, schema, meter)
    },

    applyFiltersBitset(filters: FilterExpression, schema: SchemaDefinition, meter: PatternWorkMeter): Uint32Array {
      return applyPartitionFiltersBitset(state, filters, schema, meter)
    },

    filterMatches(
      filters: FilterExpression,
      schema: SchemaDefinition,
      meter: PatternWorkMeter,
    ): PartitionFilterMatches {
      return partitionFilterMatches(state, filters, schema, meter)
    },

    computeFacets(matched: FacetMatchSet, config: FacetConfig, schema: SchemaDefinition): Record<string, FacetResult> {
      return computeFacets(state, matched, config, schema)
    },

    suggestTerms(surfacePrefix: string, stemmedPrefix: string, limit: number): PartitionSuggestion[] {
      return suggestDisplayTerms(state, surfacePrefix, stemmedPrefix, limit)
    },

    expandTermPrefix(surfacePrefix: string, stemmedToken: string, maxExpansions: number) {
      return expandTermPrefix([state], surfacePrefix, stemmedToken, maxExpansions)
    },

    expandPartialWords(analysis: PartialWordAnalysis, requests: readonly PartialWordRequest[]): AddedWord[][] {
      return expandPartialWords([state], analysis, requests)
    },

    preparePartialWords(analysis: PartialWordAnalysis): void {
      expandPartialWords([state], analysis, [])
    },

    serialize(
      indexName: string,
      totalPartitions: number,
      language: string,
      schema: SchemaDefinition,
      serializePartition: typeof import('./serialization').serializePartition,
    ): SerializablePartition {
      return serializePartition(state, partitionId, indexName, totalPartitions, language, schema)
    },

    deserialize(
      data: SerializablePartition,
      schema: SchemaDefinition,
      deserializePartition: typeof import('./serialization').deserializePartition,
    ): void {
      deserializePartition(state, data, clearAll, schema)
    },
  }

  statesByPartition.set(partition, state)
  return partition
}
