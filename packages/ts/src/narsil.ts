import { generateId } from './core/id-generator'
import { getNestedValue } from './core/partition/utils'
import { tokenize } from './core/tokenizer'
import { embedBatchDocumentFields, embedDocumentFields } from './engine/embed'
import { createWorkerOrchestrator } from './engine/orchestration'
import { executePreflight, executeQuery } from './engine/query'
import { BATCH_CHUNK_SIZE, validateDocId, validateIndexName } from './engine/validation'
import { ErrorCodes, NarsilError } from './errors'
import { getLanguage } from './languages/registry'
import { createRebalancer } from './partitioning/rebalancer'
import { createPartitionRouter } from './partitioning/router'
import { createWriteAheadQueue, type WAQEntry } from './partitioning/write-ahead-queue'
import { createFlushManager, type FlushManager } from './persistence/flush-manager'
import { createPluginRegistry, type PluginRegistry } from './plugins/registry'
import { validateEmbeddingConfig, validateRequiredFieldsInSchema } from './schema/embedding-validator'
import { extractVectorFieldsFromSchema, validateRequiredFields, validateSchema } from './schema/validator'
import { deserializePayloadV1 } from './serialization/payload-v1'
import { deserializePayloadV2 } from './serialization/payload-v2'
import type { EmbeddingAdapter } from './types/adapters'
import type { NarsilConfig } from './types/config'
import type { NarsilEventMap } from './types/events'
import type { LanguageModule } from './types/language'
import type {
  BatchResult,
  IndexInfo,
  IndexStats,
  MemoryStats,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
} from './types/results'
import type {
  AnyDocument,
  EmbeddingFieldConfig,
  IndexConfig,
  InsertOptions,
  PartitionConfig,
  SchemaDefinition,
} from './types/schema'
import type { QueryParams, SuggestParams, VectorQueryConfig } from './types/search'
import type { VectorIndexPayload } from './vector/vector-index'
import { createDirectExecutor, type DirectExecutorExtensions } from './workers/direct-executor'
import type { Executor } from './workers/executor'
import { createExecutionPromoter } from './workers/promoter'

export interface Narsil {
  createIndex(name: string, config: IndexConfig): Promise<void>
  dropIndex(name: string): Promise<void>
  listIndexes(): IndexInfo[]
  getStats(indexName: string): IndexStats
  getPartitionStats(indexName: string): PartitionStatsResult[]

  insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string>
  insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult>
  remove(indexName: string, docId: string): Promise<void>
  removeBatch(indexName: string, docIds: string[]): Promise<BatchResult>
  update(indexName: string, docId: string, document: AnyDocument): Promise<void>
  updateBatch(indexName: string, updates: Array<{ docId: string; document: AnyDocument }>): Promise<BatchResult>

  get(indexName: string, docId: string): Promise<AnyDocument | undefined>
  getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>>
  has(indexName: string, docId: string): Promise<boolean>
  countDocuments(indexName: string): Promise<number>

  query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>>
  preflight(indexName: string, params: QueryParams): Promise<PreflightResult>
  suggest(indexName: string, params: SuggestParams): Promise<SuggestResult>

  snapshot(indexName: string): Promise<Uint8Array>
  restore(indexName: string, data: Uint8Array): Promise<void>

  clear(indexName: string): Promise<void>
  rebalance(indexName: string, targetPartitionCount: number): Promise<void>
  updatePartitionConfig(indexName: string, config: Partial<PartitionConfig>): Promise<void>
  getMemoryStats(): MemoryStats

  on<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  off<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  shutdown(): Promise<void>
}

function getVectorFieldPaths(schema: SchemaDefinition): Set<string> {
  const vectorFields = extractVectorFieldsFromSchema(schema)
  return new Set(vectorFields.keys())
}

function extractVectorFromDoc(document: Record<string, unknown>, fieldPath: string): Float32Array | null {
  const value = getNestedValue(document, fieldPath)
  if (value === undefined || value === null) return null
  if (value instanceof Float32Array) return value
  if (!Array.isArray(value)) return null
  const arr = new Float32Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const n = value[i]
    if (typeof n !== 'number' || Number.isNaN(n)) return null
    arr[i] = n
  }
  return arr
}

function deleteNestedValue(obj: Record<string, unknown>, path: string): void {
  if (!path.includes('.')) {
    delete obj[path]
    return
  }
  const segments = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]]
    if (next === null || next === undefined || typeof next !== 'object') return
    current = next as Record<string, unknown>
  }
  delete current[segments[segments.length - 1]]
}

function vectorsEqual(a: Float32Array | null, b: Float32Array): boolean {
  if (!a) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export async function createNarsil(config?: NarsilConfig): Promise<Narsil> {
  const executor: Executor & DirectExecutorExtensions = createDirectExecutor()

  const promoter = createExecutionPromoter({
    perIndexThreshold: config?.workers?.promotionThreshold,
    totalThreshold: config?.workers?.totalPromotionThreshold,
  })

  const pluginRegistry: PluginRegistry = createPluginRegistry()
  if (config?.plugins) {
    for (const plugin of config.plugins) {
      pluginRegistry.register(plugin)
    }
  }

  let flushManager: FlushManager | null = null
  if (config?.persistence) {
    const noopInvalidation = config.invalidation ?? {
      publish: async () => {},
      subscribe: async () => {},
      shutdown: async () => {},
    }
    flushManager = createFlushManager(
      {
        persistence: config.persistence,
        invalidation: noopInvalidation,
        interval: config.flush?.interval,
        mutationThreshold: config.flush?.mutationThreshold,
      },
      () => new Uint8Array(0),
      () => 'instance-0',
    )
  }

  const idGenerator = config?.idGenerator ?? generateId
  const indexRegistry = new Map<
    string,
    {
      config: IndexConfig
      language: LanguageModule
      embeddingAdapter: EmbeddingAdapter | null
      vectorFieldPaths: Set<string>
    }
  >()
  type EventHandler = (payload: unknown) => void
  const eventHandlers = new Map<string, Set<EventHandler>>()
  let isShutdown = false
  const abortController = new AbortController()

  const orchestrator = createWorkerOrchestrator(config, executor, promoter, indexRegistry, {
    onPromotion(workerCount, reason) {
      const handlers = eventHandlers.get('workerPromote')
      if (handlers) {
        for (const handler of handlers) {
          handler({ workerCount, reason })
        }
      }
    },
  })
  const rebalancer = createRebalancer()
  const rebalanceRouter = createPartitionRouter()
  const rebalancingIndexes = new Set<string>()
  const waqMap = new Map<string, ReturnType<typeof createWriteAheadQueue>>()
  const lastAppliedSeqMap = new Map<string, Map<number, number>>()

  function guardShutdown(): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'This Narsil instance has been shut down')
    }
  }

  function requireIndex(indexName: string): {
    config: IndexConfig
    language: LanguageModule
    embeddingAdapter: EmbeddingAdapter | null
  } {
    const entry = indexRegistry.get(indexName)
    if (!entry) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
    }
    return entry
  }

  function bufferIfRebalancing(indexName: string, entry: Omit<WAQEntry, 'sequenceNumber'>): boolean {
    if (!rebalancingIndexes.has(indexName)) return false
    const waq = waqMap.get(indexName)
    if (!waq) return false
    const clonedEntry = entry.document
      ? { ...entry, document: structuredClone(entry.document) }
      : entry
    waq.push(clonedEntry)
    return true
  }

  function requireManager(indexName: string) {
    const manager = executor.getManager(indexName)
    if (!manager) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" manager not found`, { indexName })
    }
    return manager
  }

  async function resolveVectorText(
    params: QueryParams,
    embeddingAdapter: EmbeddingAdapter | null,
  ): Promise<QueryParams> {
    if (!params.vector) return params
    if (params.vector.text === undefined && params.vector.value === undefined) return params
    if (params.vector.value !== undefined && params.vector.text === undefined) return params

    if (params.vector.text !== undefined && params.vector.value !== undefined) {
      throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, "Vector query cannot have both 'text' and 'value'")
    }

    if (!embeddingAdapter) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_CONFIG_INVALID,
        "Vector query with 'text' requires an embedding adapter on the index or instance",
      )
    }

    if (typeof params.vector.text !== 'string') {
      throw new NarsilError(
        ErrorCodes.DOC_VALIDATION_FAILED,
        `Vector query 'text' must be a string, got ${typeof params.vector.text}`,
      )
    }
    if (params.vector.text.length === 0) {
      throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, "Vector query 'text' must not be empty")
    }
    const raw = await embeddingAdapter.embed(params.vector.text, 'query', abortController.signal)
    if (!(raw instanceof Float32Array)) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_FAILED,
        `Adapter returned ${typeof raw} for query embedding, expected Float32Array`,
      )
    }
    if (raw.length !== embeddingAdapter.dimensions) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_DIMENSION_MISMATCH,
        `Adapter returned ${raw.length}-dimensional vector for query, expected ${embeddingAdapter.dimensions}`,
        { expected: embeddingAdapter.dimensions, actual: raw.length },
      )
    }
    const resolved: VectorQueryConfig = { ...params.vector, value: Array.from(raw) }
    delete resolved.text
    return { ...params, vector: resolved }
  }

  const narsil: Narsil = {
    async createIndex(name: string, indexConfig: IndexConfig): Promise<void> {
      guardShutdown()
      validateIndexName(name)

      if (indexRegistry.has(name)) {
        throw new NarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, `Index "${name}" already exists`, { indexName: name })
      }

      validateSchema(indexConfig.schema)

      let resolvedEmbeddingAdapter: EmbeddingAdapter | null = null
      if (indexConfig.embedding) {
        resolvedEmbeddingAdapter = validateEmbeddingConfig(indexConfig.embedding, indexConfig.schema, config?.embedding)
      }
      if (indexConfig.required && indexConfig.required.length > 0) {
        validateRequiredFieldsInSchema(indexConfig.required, indexConfig.schema)
      }

      const language = getLanguage(indexConfig.language ?? 'english')
      executor.createIndex(name, indexConfig, language)
      const vectorFieldPaths = getVectorFieldPaths(indexConfig.schema)
      indexRegistry.set(name, {
        config: indexConfig,
        language,
        embeddingAdapter: resolvedEmbeddingAdapter,
        vectorFieldPaths,
      })

      await pluginRegistry.runHook('onIndexCreate', { indexName: name, config: indexConfig })
    },

    async dropIndex(name: string): Promise<void> {
      guardShutdown()
      const entry = requireIndex(name)

      executor.dropIndex(name)
      indexRegistry.delete(name)

      await pluginRegistry.runHook('onIndexDrop', { indexName: name, config: entry.config })
    },

    listIndexes(): IndexInfo[] {
      const infos: IndexInfo[] = []
      for (const [name, entry] of indexRegistry) {
        const manager = executor.getManager(name)
        infos.push({
          name,
          documentCount: manager?.countDocuments() ?? 0,
          partitionCount: manager?.partitionCount ?? 0,
          language: entry.language.name,
        })
      }
      return infos
    },

    getStats(indexName: string): IndexStats {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = executor.getManager(indexName)
      const estimatedMemory = manager?.estimateMemoryBytes() ?? 0
      return {
        documentCount: manager?.countDocuments() ?? 0,
        partitionCount: manager?.partitionCount ?? 0,
        memoryBytes: estimatedMemory,
        indexSizeBytes: estimatedMemory,
        language: entry.language.name,
        schema: entry.config.schema,
      }
    },

    getPartitionStats(indexName: string): PartitionStatsResult[] {
      guardShutdown()
      requireIndex(indexName)
      const manager = executor.getManager(indexName)
      return manager?.getPartitionStats() ?? []
    },

    async insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string> {
      guardShutdown()
      const entry = requireIndex(indexName)

      const resolvedDocId = docId ?? idGenerator()
      validateDocId(resolvedDocId)

      if (bufferIfRebalancing(indexName, { action: 'insert', docId: resolvedDocId, document, indexName })) {
        return resolvedDocId
      }

      await pluginRegistry.runHook('beforeInsert', { indexName, docId: resolvedDocId, document })

      if (entry.config.required && entry.config.required.length > 0) {
        validateRequiredFields(document as Record<string, unknown>, entry.config.required)
      }

      if (entry.embeddingAdapter && entry.config.embedding) {
        await embedDocumentFields(
          document as Record<string, unknown>,
          entry.config.embedding,
          entry.embeddingAdapter,
          abortController.signal,
        )
      }

      const insertManager = requireManager(indexName)
      const insertVecIndexes = insertManager.getVectorIndexes()

      const strippedVectors = new Map<string, Float32Array>()
      if (insertVecIndexes.size > 0) {
        for (const fieldPath of entry.vectorFieldPaths) {
          const vec = extractVectorFromDoc(document as Record<string, unknown>, fieldPath)
          if (vec) {
            strippedVectors.set(fieldPath, vec)
          }
        }
      }

      const partitionDoc = strippedVectors.size > 0
        ? structuredClone(document) as AnyDocument
        : document

      if (strippedVectors.size > 0) {
        for (const fieldPath of strippedVectors.keys()) {
          deleteNestedValue(partitionDoc as Record<string, unknown>, fieldPath)
        }
      }

      await executor.execute({
        type: 'insert',
        indexName,
        docId: resolvedDocId,
        document: partitionDoc,
        requestId: resolvedDocId,
        skipClone: strippedVectors.size > 0 ? true : options?.skipClone,
      })

      const insertedVectorFields: string[] = []
      try {
        for (const [fieldPath, vector] of strippedVectors) {
          const vecIndex = insertVecIndexes.get(fieldPath)
          if (vecIndex) {
            vecIndex.insert(resolvedDocId, vector)
            insertedVectorFields.push(fieldPath)
          }
        }
      } catch (err) {
        try {
          await executor.execute({ type: 'remove', indexName, docId: resolvedDocId, requestId: resolvedDocId })
        } catch (rollbackErr) {
          console.warn(`Rollback failed for doc "${resolvedDocId}" during insert atomicity:`, rollbackErr)
        }
        for (const fieldPath of insertedVectorFields) {
          const vecIndex = insertVecIndexes.get(fieldPath)
          if (vecIndex) {
            vecIndex.remove(resolvedDocId)
          }
        }
        throw err
      }

      try {
        await pluginRegistry.runHook('afterInsert', { indexName, docId: resolvedDocId, document })
      } catch (err) {
        console.warn('afterInsert plugin hook error:', err)
      }

      flushManager?.markDirty(indexName, 0)

      await orchestrator.replicateToWorkers({
        type: 'insert',
        indexName,
        docId: resolvedDocId,
        document,
        requestId: `replicate-insert-${resolvedDocId}`,
        skipClone: options?.skipClone,
      })

      await orchestrator.checkPromotion()

      return resolvedDocId
    },

    async insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult> {
      guardShutdown()
      const entry = requireIndex(indexName)

      const succeeded: string[] = []
      const failed: BatchResult['failed'] = []
      const hasBeforeHook = pluginRegistry.hasHooks('beforeInsert')
      const hasAfterHook = pluginRegistry.hasHooks('afterInsert')
      const hasRequired = entry.config.required && entry.config.required.length > 0
      const hasEmbedding = entry.embeddingAdapter && entry.config.embedding

      const batchManager = requireManager(indexName)
      const batchVecIndexes = batchManager.getVectorIndexes()
      const batchVectorFieldPaths = batchVecIndexes.size > 0 ? entry.vectorFieldPaths : new Set<string>()

      for (let chunkStart = 0; chunkStart < documents.length; chunkStart += BATCH_CHUNK_SIZE) {
        if (abortController.signal.aborted) break

        const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, documents.length)

        const chunkFailedIndexes = new Set<number>()

        if (hasRequired) {
          for (let i = chunkStart; i < chunkEnd; i++) {
            try {
              validateRequiredFields(documents[i] as Record<string, unknown>, entry.config.required as string[])
            } catch (err) {
              chunkFailedIndexes.add(i)
              failed.push({
                docId: '',
                error:
                  err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err)),
              })
            }
          }
        }

        if (hasEmbedding) {
          const embeddableSlice: Record<string, unknown>[] = []
          const embeddableOriginalIndexes: number[] = []
          for (let i = chunkStart; i < chunkEnd; i++) {
            if (chunkFailedIndexes.has(i)) continue
            embeddableSlice.push(documents[i] as Record<string, unknown>)
            embeddableOriginalIndexes.push(i)
          }

          if (embeddableSlice.length > 0) {
            try {
              const embedResult = await embedBatchDocumentFields(
                embeddableSlice,
                entry.config.embedding as EmbeddingFieldConfig,
                entry.embeddingAdapter as EmbeddingAdapter,
                abortController.signal,
              )

              for (const [sliceIndex, error] of embedResult.failed) {
                const originalIdx = embeddableOriginalIndexes[sliceIndex]
                chunkFailedIndexes.add(originalIdx)
                failed.push({ docId: '', error })
              }
            } catch (err) {
              const embeddingError =
                err instanceof NarsilError ? err : new NarsilError(ErrorCodes.EMBEDDING_FAILED, String(err))
              for (const originalIdx of embeddableOriginalIndexes) {
                chunkFailedIndexes.add(originalIdx)
                failed.push({ docId: '', error: embeddingError })
              }
            }
          }
        }

        for (let i = chunkStart; i < chunkEnd; i++) {
          if (chunkFailedIndexes.has(i)) continue

          const docId = idGenerator()
          try {
            validateDocId(docId)

            if (hasBeforeHook) {
              await pluginRegistry.runHook('beforeInsert', { indexName, docId, document: documents[i] })
            }

            const docStrippedVectors = new Map<string, Float32Array>()
            for (const fieldPath of batchVectorFieldPaths) {
              const vec = extractVectorFromDoc(documents[i] as Record<string, unknown>, fieldPath)
              if (vec) {
                docStrippedVectors.set(fieldPath, vec)
              }
            }

            const batchPartitionDoc = docStrippedVectors.size > 0
              ? structuredClone(documents[i]) as AnyDocument
              : documents[i]

            if (docStrippedVectors.size > 0) {
              for (const fieldPath of docStrippedVectors.keys()) {
                deleteNestedValue(batchPartitionDoc as Record<string, unknown>, fieldPath)
              }
            }

            const result = executor.execute({
              type: 'insert',
              indexName,
              docId,
              document: batchPartitionDoc,
              requestId: docId,
              skipClone: docStrippedVectors.size > 0 ? true : options?.skipClone,
            })
            if (result && typeof (result as Promise<unknown>).then === 'function') {
              await result
            }

            const batchInsertedFields: string[] = []
            try {
              for (const [fieldPath, vector] of docStrippedVectors) {
                const vecIndex = batchVecIndexes.get(fieldPath)
                if (vecIndex) {
                  vecIndex.insert(docId, vector)
                  batchInsertedFields.push(fieldPath)
                }
              }
            } catch (vecErr) {
              try {
                await executor.execute({ type: 'remove', indexName, docId, requestId: docId })
              } catch (rollbackErr) {
                console.warn(`Rollback failed for doc "${docId}" during batch insert atomicity:`, rollbackErr)
              }
              for (const fieldPath of batchInsertedFields) {
                const vecIndex = batchVecIndexes.get(fieldPath)
                if (vecIndex) {
                  vecIndex.remove(docId)
                }
              }
              throw vecErr
            }

            if (hasAfterHook) {
              try {
                await pluginRegistry.runHook('afterInsert', { indexName, docId, document: documents[i] })
              } catch (err) {
                console.warn('afterInsert plugin hook error:', err)
              }
            }

            succeeded.push(docId)
          } catch (err) {
            failed.push({
              docId,
              error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err)),
            })
          }
        }

        if (chunkEnd < documents.length) {
          await new Promise<void>(r => setTimeout(r, 0))
        }
      }

      flushManager?.markDirty(indexName, 0)
      await orchestrator.checkPromotion()

      return { succeeded, failed }
    },

    async remove(indexName: string, docId: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      validateDocId(docId)

      if (bufferIfRebalancing(indexName, { action: 'remove', docId, indexName })) {
        return
      }

      await pluginRegistry.runHook('beforeRemove', { indexName, docId })

      await executor.execute({ type: 'remove', indexName, docId, requestId: docId })

      const removeManager = requireManager(indexName)
      const removeVecIndexes = removeManager.getVectorIndexes()
      for (const [, vecIndex] of removeVecIndexes) {
        vecIndex.remove(docId)
      }

      try {
        await pluginRegistry.runHook('afterRemove', { indexName, docId })
      } catch (err) {
        console.warn('afterRemove plugin hook error:', err)
      }

      flushManager?.markDirty(indexName, 0)

      await orchestrator.replicateToWorkers({
        type: 'remove',
        indexName,
        docId,
        requestId: `replicate-remove-${docId}`,
      })
    },

    async removeBatch(indexName: string, docIds: string[]): Promise<BatchResult> {
      guardShutdown()
      requireIndex(indexName)

      const succeeded: string[] = []
      const failed: BatchResult['failed'] = []

      for (let chunkStart = 0; chunkStart < docIds.length; chunkStart += BATCH_CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, docIds.length)

        for (let i = chunkStart; i < chunkEnd; i++) {
          try {
            await narsil.remove(indexName, docIds[i])
            succeeded.push(docIds[i])
          } catch (err) {
            failed.push({
              docId: docIds[i],
              error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err)),
            })
          }
        }

        if (chunkEnd < docIds.length) {
          await new Promise<void>(r => setTimeout(r, 0))
        }
      }

      return { succeeded, failed }
    },

    async update(indexName: string, docId: string, document: AnyDocument): Promise<void> {
      guardShutdown()
      const entry = requireIndex(indexName)
      validateDocId(docId)

      if (bufferIfRebalancing(indexName, { action: 'update', docId, document, indexName })) {
        return
      }

      if (entry.embeddingAdapter && entry.config.embedding) {
        await embedDocumentFields(
          document as Record<string, unknown>,
          entry.config.embedding,
          entry.embeddingAdapter,
          abortController.signal,
        )
      }

      const updateManager = requireManager(indexName)
      const oldDocument = updateManager.get(docId)

      await pluginRegistry.runHook('beforeUpdate', {
        indexName,
        docId,
        oldDocument: oldDocument ?? ({} as AnyDocument),
        newDocument: document,
      })

      const updateVecIndexes = updateManager.getVectorIndexes()
      const updateStrippedVectors = new Map<string, Float32Array | null>()
      if (updateVecIndexes.size > 0) {
        for (const fieldPath of entry.vectorFieldPaths) {
          const newVec = extractVectorFromDoc(document as Record<string, unknown>, fieldPath)
          updateStrippedVectors.set(fieldPath, newVec)
        }
      }

      const updatePartitionDoc = updateStrippedVectors.size > 0
        ? structuredClone(document) as AnyDocument
        : document

      if (updateStrippedVectors.size > 0) {
        for (const fieldPath of updateStrippedVectors.keys()) {
          deleteNestedValue(updatePartitionDoc as Record<string, unknown>, fieldPath)
        }
      }

      await executor.execute({ type: 'update', indexName, docId, document: updatePartitionDoc, requestId: docId })

      for (const [fieldPath, newVec] of updateStrippedVectors) {
        const vecIndex = updateVecIndexes.get(fieldPath)
        if (!vecIndex) continue
        if (newVec === null) {
          if (vecIndex.has(docId)) {
            vecIndex.remove(docId)
          }
        } else {
          const oldVec = vecIndex.getVector(docId)
          if (!vectorsEqual(oldVec, newVec)) {
            vecIndex.remove(docId)
            try {
              vecIndex.insert(docId, newVec)
            } catch (err) {
              if (oldVec) {
                vecIndex.insert(docId, oldVec)
              }
              throw err
            }
          }
        }
      }

      try {
        await pluginRegistry.runHook('afterUpdate', {
          indexName,
          docId,
          oldDocument: oldDocument ?? ({} as AnyDocument),
          newDocument: document,
        })
      } catch (err) {
        console.warn('afterUpdate plugin hook error:', err)
      }

      flushManager?.markDirty(indexName, 0)

      await orchestrator.replicateToWorkers({
        type: 'update',
        indexName,
        docId,
        document,
        requestId: `replicate-update-${docId}`,
      })
    },

    async updateBatch(
      indexName: string,
      updates: Array<{ docId: string; document: AnyDocument }>,
    ): Promise<BatchResult> {
      guardShutdown()
      requireIndex(indexName)

      const succeeded: string[] = []
      const failed: BatchResult['failed'] = []

      for (let chunkStart = 0; chunkStart < updates.length; chunkStart += BATCH_CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, updates.length)

        for (let i = chunkStart; i < chunkEnd; i++) {
          try {
            await narsil.update(indexName, updates[i].docId, updates[i].document)
            succeeded.push(updates[i].docId)
          } catch (err) {
            failed.push({
              docId: updates[i].docId,
              error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err)),
            })
          }
        }

        if (chunkEnd < updates.length) {
          await new Promise<void>(r => setTimeout(r, 0))
        }
      }

      return { succeeded, failed }
    },

    async get(indexName: string, docId: string): Promise<AnyDocument | undefined> {
      guardShutdown()
      requireIndex(indexName)
      return executor.execute({ type: 'get', indexName, docId, requestId: docId })
    },

    async getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>> {
      guardShutdown()
      requireIndex(indexName)

      const result = new Map<string, AnyDocument>()
      for (const docId of docIds) {
        const doc = await narsil.get(indexName, docId)
        if (doc !== undefined) {
          result.set(docId, doc)
        }
      }
      return result
    },

    async has(indexName: string, docId: string): Promise<boolean> {
      guardShutdown()
      requireIndex(indexName)
      return executor.execute({ type: 'has', indexName, docId, requestId: docId })
    },

    async countDocuments(indexName: string): Promise<number> {
      guardShutdown()
      requireIndex(indexName)
      return executor.execute({ type: 'count', indexName, requestId: indexName })
    },

    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = requireManager(indexName)

      const resolvedParams = await resolveVectorText(params, entry.embeddingAdapter)

      await pluginRegistry.runHook('beforeSearch', { indexName, params: resolvedParams })

      const workerSearch = orchestrator.isPromoted() ? orchestrator.searchViaWorker.bind(orchestrator) : undefined

      const result = await executeQuery<T>(resolvedParams, {
        manager,
        language: entry.language,
        config: entry.config,
        workerSearch,
        indexName,
      })

      try {
        await pluginRegistry.runHook('afterSearch', {
          indexName,
          params: resolvedParams,
          results: result as unknown as QueryResult,
        })
      } catch (err) {
        console.warn('afterSearch plugin hook error:', err)
      }

      return result
    },

    async preflight(indexName: string, params: QueryParams): Promise<PreflightResult> {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = requireManager(indexName)

      const resolvedParams = await resolveVectorText(params, entry.embeddingAdapter)

      const workerSearch = orchestrator.isPromoted() ? orchestrator.searchViaWorker.bind(orchestrator) : undefined

      return executePreflight(resolvedParams, {
        manager,
        language: entry.language,
        config: entry.config,
        workerSearch,
        indexName,
      })
    },

    async suggest(indexName: string, params: SuggestParams): Promise<SuggestResult> {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = requireManager(indexName)

      const t0 = performance.now()
      const limit = Math.max(1, Math.min(params.limit ?? 10, 100))
      const rawPrefix = params.prefix.trim()

      if (rawPrefix.length === 0) {
        return { terms: [], elapsed: performance.now() - t0 }
      }

      const unstemmed = tokenize(rawPrefix, entry.language, { stem: false, removeStopWords: false })
      const lastToken =
        unstemmed.tokens.length > 0 ? unstemmed.tokens[unstemmed.tokens.length - 1].token : rawPrefix.toLowerCase()

      if (lastToken.length === 0) {
        return { terms: [], elapsed: performance.now() - t0 }
      }

      const stemmed = entry.language.stemmer ? entry.language.stemmer(lastToken) : lastToken
      const prefixes = stemmed !== lastToken ? [lastToken, stemmed] : [lastToken]

      const partitions = manager.getAllPartitions()
      const merged = new Map<string, number>()
      const perPartitionLimit = limit * 2

      for (const partition of partitions) {
        const seen = new Set<string>()
        for (const prefix of prefixes) {
          const suggestions = partition.suggestTerms(prefix, perPartitionLimit)
          for (const s of suggestions) {
            if (seen.has(s.term)) continue
            seen.add(s.term)
            merged.set(s.term, (merged.get(s.term) ?? 0) + s.documentFrequency)
          }
        }
      }

      const terms = Array.from(merged.entries())
        .map(([term, documentFrequency]) => ({ term, documentFrequency }))
        .sort((a, b) => b.documentFrequency - a.documentFrequency)

      if (terms.length > limit) terms.length = limit

      return { terms, elapsed: performance.now() - t0 }
    },

    async snapshot(indexName: string): Promise<Uint8Array> {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = requireManager(indexName)

      const partitionBuffers: Uint8Array[] = []
      for (let i = 0; i < manager.partitionCount; i++) {
        partitionBuffers.push(manager.serializePartitionToBytes(i))
      }

      const snapshotVecIndexes = manager.getVectorIndexes()
      const vectorPayloads: Record<string, VectorIndexPayload> = {}
      for (const [fieldPath, vecIndex] of snapshotVecIndexes) {
        vectorPayloads[fieldPath] = vecIndex.serialize()
      }

      const { encode } = await import('@msgpack/msgpack')
      return encode({
        version: 2,
        schema: entry.config.schema,
        language: entry.language.name,
        partitions: partitionBuffers,
        vectorIndexes: vectorPayloads,
      })
    },

    async restore(indexName: string, data: Uint8Array): Promise<void> {
      guardShutdown()

      if (!(data instanceof Uint8Array)) {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Snapshot data must be a Uint8Array')
      }

      const { decode } = await import('@msgpack/msgpack')
      const envelope = decode(data) as {
        version?: number
        schema?: Record<string, string>
        language?: string
        partitions?: Uint8Array[]
        vectorIndexes?: Record<string, VectorIndexPayload>
      }

      if (envelope.version !== 1 && envelope.version !== 2) {
        throw new NarsilError(
          ErrorCodes.DOC_VALIDATION_FAILED,
          `Unsupported snapshot version: ${envelope.version}. Expected version 1 or 2`,
          { version: envelope.version },
        )
      }

      if (!envelope.schema || typeof envelope.schema !== 'object') {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: missing or invalid schema')
      }

      if (!envelope.language || typeof envelope.language !== 'string') {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: missing or invalid language')
      }

      if (!Array.isArray(envelope.partitions)) {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: missing partitions')
      }

      const language = getLanguage(envelope.language)
      const schema = envelope.schema as SchemaDefinition
      validateSchema(schema)

      if (indexRegistry.has(indexName)) {
        await narsil.dropIndex(indexName)
      }

      const indexConfig: IndexConfig = { schema, language: envelope.language }
      executor.createIndex(indexName, indexConfig, language)
      const vectorFieldPaths = getVectorFieldPaths(schema)
      indexRegistry.set(indexName, { config: indexConfig, language, embeddingAdapter: null, vectorFieldPaths })

      try {
        const manager = requireManager(indexName)

        while (manager.partitionCount < envelope.partitions.length) {
          manager.addPartition()
        }

        const deserializePartitionPayload = envelope.version === 2 ? deserializePayloadV2 : deserializePayloadV1

        for (let i = 0; i < envelope.partitions.length; i++) {
          const partition = deserializePartitionPayload(envelope.partitions[i])
          manager.deserializePartition(i, partition)
        }

        if (envelope.vectorIndexes) {
          const restoreVecIndexes = manager.getVectorIndexes()
          for (const [fieldPath, payload] of Object.entries(envelope.vectorIndexes)) {
            const vecIndex = restoreVecIndexes.get(fieldPath)
            if (vecIndex) {
              vecIndex.deserialize(payload)
            }
          }
        }
      } catch (err) {
        try {
          executor.dropIndex(indexName)
          indexRegistry.delete(indexName)
        } catch (_) {
          /* cleanup best-effort */
        }
        throw err
      }
    },

    async clear(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await executor.execute({ type: 'clear', indexName, requestId: indexName })
      await orchestrator.replicateToWorkers({ type: 'clear', indexName, requestId: `replicate-clear-${indexName}` })
    },

    async rebalance(indexName: string, targetPartitionCount: number): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      const manager = requireManager(indexName)

      if (targetPartitionCount <= 0 || !Number.isInteger(targetPartitionCount)) {
        throw new NarsilError(
          ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
          `Target partition count must be a positive integer, got ${targetPartitionCount}`,
          { targetPartitionCount },
        )
      }

      if (rebalancingIndexes.has(indexName)) {
        throw new NarsilError(
          ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
          `Index "${indexName}" is already being rebalanced`,
        )
      }

      if (targetPartitionCount === manager.partitionCount) {
        return
      }

      const waq = createWriteAheadQueue()
      waqMap.set(indexName, waq)
      rebalancingIndexes.add(indexName)

      try {
        const oldCount = manager.partitionCount
        await rebalancer.rebalance(manager, targetPartitionCount, rebalanceRouter, progress => {
          if (progress.phase === 'complete') {
            const handlers = eventHandlers.get('partitionRebalance')
            if (handlers) {
              for (const handler of handlers) {
                handler({ indexName, oldCount, newCount: targetPartitionCount })
              }
            }
          }
        })

        const entries = waq.drain()
        const appliedSeqs = lastAppliedSeqMap.get(indexName) ?? new Map<number, number>()
        const rebalanceEntry = requireIndex(indexName)
        const rebalanceVecIndexes = manager.getVectorIndexes()
        const rebalanceVectorFieldPaths =
          rebalanceVecIndexes.size > 0 ? rebalanceEntry.vectorFieldPaths : new Set<string>()

        for (const entry of entries) {
          const partitionLastSeq = appliedSeqs.get(0) ?? 0
          if (entry.sequenceNumber <= partitionLastSeq) continue

          try {
            if (entry.action === 'insert' && entry.document) {
              const replayVectors = new Map<string, Float32Array>()
              for (const fieldPath of rebalanceVectorFieldPaths) {
                const vec = extractVectorFromDoc(entry.document as Record<string, unknown>, fieldPath)
                if (vec) {
                  replayVectors.set(fieldPath, vec)
                }
              }
              const replayInsertDoc = replayVectors.size > 0
                ? structuredClone(entry.document) as AnyDocument
                : entry.document
              if (replayVectors.size > 0) {
                for (const fieldPath of replayVectors.keys()) {
                  deleteNestedValue(replayInsertDoc as Record<string, unknown>, fieldPath)
                }
              }
              manager.insert(entry.docId, replayInsertDoc)
              for (const [fieldPath, vec] of replayVectors) {
                const vecIndex = rebalanceVecIndexes.get(fieldPath)
                if (vecIndex) {
                  vecIndex.insert(entry.docId, vec)
                }
              }
            } else if (entry.action === 'remove') {
              manager.remove(entry.docId)
              for (const [, vecIndex] of rebalanceVecIndexes) {
                vecIndex.remove(entry.docId)
              }
            } else if (entry.action === 'update' && entry.document) {
              const replayUpdateVectors = new Map<string, Float32Array | null>()
              for (const fieldPath of rebalanceVectorFieldPaths) {
                const newVec = extractVectorFromDoc(entry.document as Record<string, unknown>, fieldPath)
                replayUpdateVectors.set(fieldPath, newVec)
              }
              const replayUpdateDoc = replayUpdateVectors.size > 0
                ? structuredClone(entry.document) as AnyDocument
                : entry.document
              if (replayUpdateVectors.size > 0) {
                for (const fieldPath of replayUpdateVectors.keys()) {
                  deleteNestedValue(replayUpdateDoc as Record<string, unknown>, fieldPath)
                }
              }
              manager.update(entry.docId, replayUpdateDoc)
              for (const [fieldPath, newVec] of replayUpdateVectors) {
                const vecIndex = rebalanceVecIndexes.get(fieldPath)
                if (!vecIndex) continue
                if (newVec === null) {
                  if (vecIndex.has(entry.docId)) {
                    vecIndex.remove(entry.docId)
                  }
                } else {
                  const oldVec = vecIndex.getVector(entry.docId)
                  if (!vectorsEqual(oldVec, newVec)) {
                    vecIndex.remove(entry.docId)
                    vecIndex.insert(entry.docId, newVec)
                  }
                }
              }
            }
          } catch (replayErr) {
            const isDuplicate = replayErr instanceof NarsilError && replayErr.code === ErrorCodes.DOC_ALREADY_EXISTS
            const isMissing = replayErr instanceof NarsilError && replayErr.code === ErrorCodes.DOC_NOT_FOUND
            if (!isDuplicate && !isMissing) {
              console.warn(`WAQ replay failed for ${entry.action} on doc "${entry.docId}":`, replayErr)
            }
          }
          appliedSeqs.set(0, entry.sequenceNumber)
        }
        lastAppliedSeqMap.set(indexName, appliedSeqs)
      } finally {
        rebalancingIndexes.delete(indexName)
        waqMap.delete(indexName)
      }
    },

    async updatePartitionConfig(indexName: string, partitionConfig: Partial<PartitionConfig>): Promise<void> {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = requireManager(indexName)

      if (rebalancingIndexes.has(indexName)) {
        throw new NarsilError(
          ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
          `Index "${indexName}" is currently being rebalanced`,
        )
      }

      const currentDocCount = manager.countDocuments()
      const newMaxDocs = partitionConfig.maxDocsPerPartition ?? entry.config.partitions?.maxDocsPerPartition
      const newMaxPartitions =
        partitionConfig.maxPartitions ?? entry.config.partitions?.maxPartitions ?? manager.partitionCount

      if (newMaxDocs !== undefined) {
        const newTotalCapacity = newMaxDocs * newMaxPartitions
        if (newTotalCapacity < currentDocCount) {
          throw new NarsilError(
            ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
            `New capacity (${newTotalCapacity}) is less than current document count (${currentDocCount})`,
            { newTotalCapacity, currentDocCount },
          )
        }
      }

      if (!entry.config.partitions) {
        entry.config.partitions = {}
      }
      if (partitionConfig.maxDocsPerPartition !== undefined) {
        entry.config.partitions.maxDocsPerPartition = partitionConfig.maxDocsPerPartition
      }
      if (partitionConfig.maxPartitions !== undefined) {
        entry.config.partitions.maxPartitions = partitionConfig.maxPartitions
      }
    },

    getMemoryStats(): MemoryStats {
      const workerStats = orchestrator.getMemoryStats()
      let mainThreadBytes = 0
      for (const [name] of indexRegistry) {
        const manager = executor.getManager(name)
        if (manager) {
          mainThreadBytes += manager.estimateMemoryBytes()
        }
      }
      return {
        totalBytes: mainThreadBytes + workerStats.totalBytes,
        workers: workerStats.workers,
      }
    },

    on<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void {
      const key = event as string
      let handlers = eventHandlers.get(key)
      if (!handlers) {
        handlers = new Set()
        eventHandlers.set(key, handlers)
      }
      handlers.add(handler as EventHandler)
    },

    off<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void {
      const key = event as string
      const handlers = eventHandlers.get(key)
      if (handlers) {
        handlers.delete(handler as EventHandler)
        if (handlers.size === 0) {
          eventHandlers.delete(key)
        }
      }
    },

    async shutdown(): Promise<void> {
      if (isShutdown) return
      isShutdown = true

      abortController.abort()

      if (flushManager) {
        await flushManager.shutdown()
      }

      const adaptersToShutdown = new Set<EmbeddingAdapter>()
      for (const [, entry] of indexRegistry) {
        if (entry.embeddingAdapter?.shutdown) {
          adaptersToShutdown.add(entry.embeddingAdapter)
        }
      }
      for (const adapter of adaptersToShutdown) {
        try {
          await adapter.shutdown?.()
        } catch (_) {
          /* best-effort adapter shutdown */
        }
      }

      await orchestrator.shutdown()
      await executor.shutdown()
      eventHandlers.clear()
      indexRegistry.clear()
    },
  }

  return narsil
}
