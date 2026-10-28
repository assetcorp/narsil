import { ErrorCodes, NarsilError } from '../../errors'
import { partialFieldsOf, schemaFieldsOf, validateDocument, validateDocumentStrict } from '../../schema/validator'
import type { FilterExpression } from '../../types/filters'
import type {
  GlobalStatistics,
  InternalSearchParams,
  InternalSearchResult,
  ScoredDocument,
  SerializablePartition,
} from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { FacetResult } from '../../types/results'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { createDocumentStore } from '../document-store'
import { createInvertedIndex } from '../inverted-index'
import type { ComparableSortValue, SortMode } from '../ordering'
import type { PatternWorkMeter } from '../pattern-index/types'
import { cloneProjected, type ResolvedProjection } from '../projection'
import { createPartitionStats } from '../statistics'
import { createSurfaceRegistry } from '../surface-registry'
import { computeFacets, type FacetMatchSet } from './facets'
import { updateFieldIndexOnly } from './field-updates'
import {
  applyPartitionFilters,
  applyPartitionFiltersBitset,
  type PartitionFilterMatches,
  partitionFilterMatches,
} from './filters'
import { indexDocument, removeFromIndexes } from './indexing'
import { type PartitionSearchMatches, searchFulltextMatches } from './matches'
import { estimatePartitionBytes } from './memory'
import { mergeSegmentState } from './merge'
import { createGrowingPartialWords, expandPartialWords } from './partial-words/registry'
import type { PartialWordAnalysis } from './partial-words/spellings'
import type { AddedWord, PartialWordRequest } from './partial-words/types'
import type { PartitionIndex } from './partition-index'
import { searchFulltext } from './search'
import { encodeSegmentState, mergeSegmentPayload, type SegmentPayload } from './segment-payload'
import { deserializePartition, serializePartition } from './serialization'
import {
  forgetSortValues,
  recordSortValues,
  refreshSortColumns,
  type SortedPageEntry,
  type SortPageRequest,
  sortedPageOf,
  sortValuesOf,
} from './sorting'
import { expandTermPrefix, type PartitionSuggestion, suggestDisplayTerms } from './suggestions'
import { type PartitionInsertOptions, type PartitionState, textFieldsChanged } from './utils'

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
    stats: createPartitionStats(),
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
  }

  function clearAll(): void {
    state.invertedIdx.clear()
    state.docStore.clear()
    state.surfaceRegistry.clear()
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
    state.partialWords.clear()
    state.stats.deserialize({ totalDocuments: 0, totalFieldLengths: {}, averageFieldLengths: {}, docFrequencies: {} })
    state.flatSchemaCache = null
    state.lastSchemaRef = null
    state.sortColumns = null
    state.scoreBuffer = null
  }

  const partition: PartitionIndex = {
    get partitionId() {
      return partitionId
    },
    get stats() {
      return state.stats
    },

    insert(
      docId: string,
      document: AnyDocument,
      schema: SchemaDefinition,
      language: LanguageModule,
      options?: PartitionInsertOptions,
    ): void {
      if (state.docStore.has(docId)) {
        throw new NarsilError(
          ErrorCodes.DOC_ALREADY_EXISTS,
          `Document "${docId}" already exists in partition ${partitionId}`,
          { docId, partitionId },
        )
      }

      if (options?.validate !== false) {
        validateDocument(document, schema, options?.patternValueLimit)
        if (options?.strict) {
          validateDocumentStrict(document as Record<string, unknown>, schema)
        }
      }

      const internalId = state.docStore.ensureInternalId(docId)
      const { fieldLengths, tokensByField, partialSpellings } = indexDocument(
        state,
        docId,
        document as Record<string, unknown>,
        schemaFieldsOf(schema),
        language,
        options,
      )
      if (options?.skipClone) {
        state.docStore.storeRef(docId, document, fieldLengths)
      } else {
        state.docStore.store(docId, document, fieldLengths)
      }
      state.stats.addDocument(fieldLengths, tokensByField)
      state.partialWords.afterDocument(partialFieldsOf(schema), internalId, partialSpellings, 1)
      recordSortValues(state, internalId, document as Record<string, unknown>)
    },

    remove(docId: string, schema: SchemaDefinition, language: LanguageModule, options?: PartitionInsertOptions): void {
      const stored = state.docStore.get(docId)
      if (!stored) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in partition ${partitionId}`, {
          docId,
          partitionId,
        })
      }

      const { fieldLengths, tokensByField, partialSpellings } = removeFromIndexes(
        state,
        docId,
        stored,
        schemaFieldsOf(schema),
        language,
        options,
      )
      const internalId = state.docStore.getInternalId(docId)
      state.docStore.remove(docId)
      state.stats.removeDocument(fieldLengths, tokensByField)
      if (internalId !== undefined) {
        state.partialWords.afterDocument(partialFieldsOf(schema), internalId, partialSpellings, -1)
      }
      forgetSortValues(state, internalId)
    },

    beginBatch(): void {
      state.invertedIdx.beginBatch()
    },

    endBatch(): void {
      state.invertedIdx.endBatch()
      refreshSortColumns(state)
    },

    mergeSegment(segment: PartitionIndex): void {
      mergeSegmentState(state, readSegmentState(segment))
    },

    encodeSegment(): SegmentPayload {
      return encodeSegmentState(state)
    },

    mergeSegmentPayload(payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void {
      mergeSegmentPayload(state, payload, documents)
    },

    update(
      docId: string,
      document: AnyDocument,
      schema: SchemaDefinition,
      language: LanguageModule,
      options?: PartitionInsertOptions,
    ): void {
      const stored = state.docStore.get(docId)
      if (!stored) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in partition ${partitionId}`, {
          docId,
          partitionId,
        })
      }

      if (options?.validate !== false) {
        validateDocument(document, schema, options?.patternValueLimit)
        if (options?.strict) {
          validateDocumentStrict(document as Record<string, unknown>, schema)
        }
      }

      const fields = schemaFieldsOf(schema)
      const needsTextReindex = textFieldsChanged(stored.fields, document as Record<string, unknown>, fields)

      if (needsTextReindex) {
        const previous = removeFromIndexes(state, docId, stored, fields, language, options)
        state.stats.removeDocument(previous.fieldLengths, previous.tokensByField)
        const previousInternalId = state.docStore.getInternalId(docId)
        if (previousInternalId !== undefined) {
          state.partialWords.afterDocument(partialFieldsOf(schema), previousInternalId, previous.partialSpellings, -1)
        }
        state.docStore.remove(docId)
        forgetSortValues(state, previousInternalId)
        const internalId = state.docStore.ensureInternalId(docId)

        const next = indexDocument(state, docId, document as Record<string, unknown>, fields, language, options)
        state.docStore.store(docId, document, next.fieldLengths)
        state.stats.addDocument(next.fieldLengths, next.tokensByField)
        state.partialWords.afterDocument(partialFieldsOf(schema), internalId, next.partialSpellings, 1)
        recordSortValues(state, internalId, document as Record<string, unknown>)
      } else {
        updateFieldIndexOnly(state, docId, stored.fields, document as Record<string, unknown>, fields)
        state.docStore.store(docId, document, stored.fieldLengths)
        const internalId = state.docStore.getInternalId(docId)
        if (internalId !== undefined) recordSortValues(state, internalId, document as Record<string, unknown>)
      }
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

    searchFulltext(params: InternalSearchParams): InternalSearchResult {
      return searchFulltext(state, params)
    },

    searchFulltextMatches(params: InternalSearchParams): PartitionSearchMatches {
      return searchFulltextMatches(state, params)
    },

    sortedPage(request: SortPageRequest): SortedPageEntry[] {
      return sortedPageOf(state, request)
    },

    sortValues(
      docId: string,
      fields: readonly string[],
      fieldTypes: readonly (string | undefined)[],
      modes: readonly SortMode[],
    ): ComparableSortValue[] {
      return sortValuesOf(state, docId, fields, fieldTypes, modes)
    },

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

    expandTermPrefix(surfacePrefix: string, stemmedToken: string, maxExpansions: number): string[] {
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
    ): SerializablePartition {
      return serializePartition(state, partitionId, indexName, totalPartitions, language, schema)
    },

    deserialize(data: SerializablePartition, schema: SchemaDefinition): void {
      deserializePartition(state, data, clearAll, schema)
    },
  }

  statesByPartition.set(partition, state)
  return partition
}
