import { ErrorCodes, NarsilError } from '../../errors'
import { validateDocument, validateDocumentStrict } from '../../schema/validator'
import { encodeRawPayload } from '../../serialization/payload-v1'
import type { FilterExpression } from '../../types/filters'
import type {
  GlobalStatistics,
  InternalSearchParams,
  InternalSearchResult,
  InternalVectorParams,
  ScoredDocument,
  SerializablePartition,
} from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { FacetResult } from '../../types/results'
import type { AnyDocument, SchemaDefinition, VectorPromotionConfig } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { createVectorPromoter, type VectorPromoter } from '../../vector/promoter'
import { createDocumentStore } from '../document-store'
import { createInvertedIndex } from '../inverted-index'
import { createPartitionStats, type PartitionStats } from '../statistics'
import { indexDocument, removeFromIndexes, updateFieldIndexOnly } from './indexing'
import { applyPartitionFilters, computeFacets, searchFulltext, searchVector } from './search'
import { deserializePartition, serializePartition, serializePartitionToWirePayload } from './serialization'
import { getFlatSchema, type PartitionInsertOptions, type PartitionState, textFieldsChanged } from './utils'

export type { GlobalStatistics, InternalSearchParams, InternalSearchResult, InternalVectorParams, ScoredDocument }
export type { PartitionInsertOptions }

export interface PartitionIndex {
  readonly partitionId: number
  readonly stats: PartitionStats

  insert(
    docId: string,
    document: AnyDocument,
    schema: SchemaDefinition,
    language: LanguageModule,
    options?: PartitionInsertOptions,
  ): void
  remove(docId: string, schema: SchemaDefinition, language: LanguageModule, options?: PartitionInsertOptions): void
  update(
    docId: string,
    document: AnyDocument,
    schema: SchemaDefinition,
    language: LanguageModule,
    options?: PartitionInsertOptions,
  ): void
  get(docId: string): AnyDocument | undefined
  getRef(docId: string): AnyDocument | undefined
  has(docId: string): boolean
  count(): number
  docIds(): IterableIterator<string>
  clear(): void

  searchFulltext(params: InternalSearchParams): InternalSearchResult
  searchVector(params: InternalVectorParams): InternalSearchResult
  applyFilters(filters: FilterExpression, schema: SchemaDefinition): Set<string>
  computeFacets(docIds: Set<string>, config: FacetConfig, schema: SchemaDefinition): Record<string, FacetResult>

  estimateMemoryBytes(): number
  vectorFieldCount(): number
  hasPromotedHnsw(): boolean

  serialize(
    indexName: string,
    totalPartitions: number,
    language: string,
    schema: SchemaDefinition,
  ): SerializablePartition
  serializeToBytes(indexName: string, totalPartitions: number, language: string, schema: SchemaDefinition): Uint8Array
  deserialize(data: SerializablePartition, schema: SchemaDefinition): void
}

export function createPartitionIndex(
  partitionId: number,
  trackPositions = true,
  vectorPromotionConfig?: VectorPromotionConfig,
): PartitionIndex {
  const vectorPromoter: VectorPromoter | null = vectorPromotionConfig
    ? createVectorPromoter({
        promotionThreshold: vectorPromotionConfig.threshold,
        hnswConfig: vectorPromotionConfig.hnswConfig,
        workerStrategy: vectorPromotionConfig.workerStrategy,
      })
    : null

  const fieldNameTable = { names: [] as string[], indexMap: new Map<string, number>() }

  const state: PartitionState = {
    invertedIdx: createInvertedIndex(fieldNameTable),
    docStore: createDocumentStore(),
    stats: createPartitionStats(),
    numericIndexes: new Map(),
    booleanIndexes: new Map(),
    enumIndexes: new Map(),
    geoIndexes: new Map(),
    vectorStores: new Map(),
    fieldNameTable,
    flatSchemaCache: null,
    lastSchemaRef: null,
    trackPositions,
  }

  function clearAll(): void {
    vectorPromoter?.shutdown()
    state.invertedIdx.clear()
    state.docStore.clear()
    for (const idx of state.numericIndexes.values()) idx.clear()
    for (const idx of state.booleanIndexes.values()) idx.clear()
    for (const idx of state.enumIndexes.values()) idx.clear()
    for (const idx of state.geoIndexes.values()) idx.clear()
    for (const store of state.vectorStores.values()) store.clear()
    state.numericIndexes.clear()
    state.booleanIndexes.clear()
    state.enumIndexes.clear()
    state.geoIndexes.clear()
    state.vectorStores.clear()
    state.stats.deserialize({ totalDocuments: 0, totalFieldLengths: {}, averageFieldLengths: {}, docFrequencies: {} })
    state.flatSchemaCache = null
    state.lastSchemaRef = null
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
        validateDocument(document, schema)
        if (options?.strict) {
          validateDocumentStrict(document as Record<string, unknown>, schema)
        }
      }

      const flatSchema = getFlatSchema(state, schema)
      const { fieldLengths, tokensByField } = indexDocument(
        state,
        docId,
        document as Record<string, unknown>,
        flatSchema,
        language,
        options,
      )
      if (options?.skipClone) {
        state.docStore.storeRef(docId, document, fieldLengths)
      } else {
        state.docStore.store(docId, document, fieldLengths)
      }
      state.stats.addDocument(fieldLengths, tokensByField)
      vectorPromoter?.check(state.vectorStores)
    },

    remove(docId: string, schema: SchemaDefinition, language: LanguageModule, options?: PartitionInsertOptions): void {
      const stored = state.docStore.get(docId)
      if (!stored) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in partition ${partitionId}`, {
          docId,
          partitionId,
        })
      }

      const flatSchema = getFlatSchema(state, schema)
      const { fieldLengths, tokensByField } = removeFromIndexes(state, docId, stored, flatSchema, language, options)
      state.docStore.remove(docId)
      state.stats.removeDocument(fieldLengths, tokensByField)
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
        validateDocument(document, schema)
        if (options?.strict) {
          validateDocumentStrict(document as Record<string, unknown>, schema)
        }
      }

      const flatSchema = getFlatSchema(state, schema)
      const needsTextReindex = textFieldsChanged(stored.fields, document as Record<string, unknown>, flatSchema)

      if (needsTextReindex) {
        const { fieldLengths: oldFieldLengths, tokensByField: oldTokens } = removeFromIndexes(
          state,
          docId,
          stored,
          flatSchema,
          language,
          options,
        )
        state.stats.removeDocument(oldFieldLengths, oldTokens)
        state.docStore.remove(docId)

        const { fieldLengths: newFieldLengths, tokensByField: newTokens } = indexDocument(
          state,
          docId,
          document as Record<string, unknown>,
          flatSchema,
          language,
          options,
        )
        state.docStore.store(docId, document, newFieldLengths)
        state.stats.addDocument(newFieldLengths, newTokens)
      } else {
        updateFieldIndexOnly(state, docId, stored.fields, document as Record<string, unknown>, flatSchema)
        state.docStore.store(docId, document, stored.fieldLengths)
      }
    },

    get(docId: string): AnyDocument | undefined {
      const stored = state.docStore.get(docId)
      if (!stored) return undefined
      return structuredClone(stored.fields) as AnyDocument
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

    clear: clearAll,

    estimateMemoryBytes(): number {
      const docCount = state.docStore.count()
      if (docCount === 0) return 0

      const AVG_DOC_OVERHEAD = 350
      let bytes = docCount * AVG_DOC_OVERHEAD

      const docFreqs = state.stats.docFrequencies
      const POSTING_ENTRY_SIZE = 24
      const PER_TERM_OVERHEAD = 180
      let totalPostings = 0
      let termCount = 0
      for (const term in docFreqs) {
        totalPostings += docFreqs[term]
        termCount++
      }
      bytes += totalPostings * POSTING_ENTRY_SIZE
      bytes += termCount * PER_TERM_OVERHEAD

      const FIELD_ENTRY_OVERHEAD = 42
      bytes += docCount * state.numericIndexes.size * FIELD_ENTRY_OVERHEAD
      bytes += docCount * state.booleanIndexes.size * FIELD_ENTRY_OVERHEAD
      bytes += docCount * state.enumIndexes.size * FIELD_ENTRY_OVERHEAD
      bytes += docCount * state.geoIndexes.size * FIELD_ENTRY_OVERHEAD

      for (const store of state.vectorStores.values()) {
        bytes += store.estimateMemoryBytes()
      }

      return bytes
    },

    vectorFieldCount(): number {
      return state.vectorStores.size
    },

    hasPromotedHnsw(): boolean {
      for (const store of state.vectorStores.values()) {
        if (store.isPromoted) return true
      }
      return false
    },

    searchFulltext(params: InternalSearchParams): InternalSearchResult {
      return searchFulltext(state, params)
    },

    searchVector(params: InternalVectorParams): InternalSearchResult {
      return searchVector(state, params)
    },

    applyFilters(filters: FilterExpression, schema: SchemaDefinition): Set<string> {
      return applyPartitionFilters(state, filters, schema)
    },

    computeFacets(docIds: Set<string>, config: FacetConfig, schema: SchemaDefinition): Record<string, FacetResult> {
      return computeFacets(state, docIds, config, schema)
    },

    serialize(
      indexName: string,
      totalPartitions: number,
      language: string,
      schema: SchemaDefinition,
    ): SerializablePartition {
      return serializePartition(state, partitionId, indexName, totalPartitions, language, schema)
    },

    serializeToBytes(
      indexName: string,
      totalPartitions: number,
      language: string,
      schema: SchemaDefinition,
    ): Uint8Array {
      const wire = serializePartitionToWirePayload(state, partitionId, indexName, totalPartitions, language, schema)
      return encodeRawPayload(wire)
    },

    deserialize(data: SerializablePartition, schema: SchemaDefinition): void {
      deserializePartition(state, data, clearAll, schema)
    },
  }

  return partition
}
