import { createEngineCore, type EventHandler, getVectorFieldPaths } from './engine/core'
import {
  insertDocument,
  insertDocumentBatch,
  removeDocument,
  removeDocumentBatch,
  updateDocument,
  updateDocumentBatch,
} from './engine/mutations'
import { executePreflight, executeQuery } from './engine/query'
import { executeRebalance } from './engine/rebalance-executor'
import { resolveVectorText } from './engine/resolve-vector-text'
import { createSnapshot, restoreFromSnapshot } from './engine/snapshot'
import { executeSuggest } from './engine/suggest'
import { validateIndexName } from './engine/validation'
import {
  compactVectors as executeCompactVectors,
  optimizeVectors as executeOptimizeVectors,
  getVectorMaintenanceStatus,
} from './engine/vector-maintenance'
import { ErrorCodes, NarsilError } from './errors'
import { getLanguage } from './languages/registry'
import { validateEmbeddingConfig, validateRequiredFieldsInSchema } from './schema/embedding-validator'
import { validateSchema } from './schema/validator'
import type { EmbeddingAdapter } from './types/adapters'
import type { NarsilConfig } from './types/config'
import type { NarsilEventMap } from './types/events'
import type {
  BatchResult,
  IndexInfo,
  IndexStats,
  MemoryStats,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
  VectorMaintenanceResult,
} from './types/results'
import type { AnyDocument, IndexConfig, InsertOptions, PartitionConfig } from './types/schema'
import type { QueryParams, SuggestParams } from './types/search'

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
  compactVectors(indexName: string, fieldName?: string): Promise<void>
  optimizeVectors(indexName: string, fieldName?: string): Promise<void>
  vectorMaintenanceStatus(indexName: string): VectorMaintenanceResult[]
  on<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  off<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  shutdown(): Promise<void>
}

export async function createNarsil(config?: NarsilConfig): Promise<Narsil> {
  const core = createEngineCore(config)
  const {
    executor,
    pluginRegistry,
    flushManager,
    indexRegistry,
    eventHandlers,
    shutdownState,
    abortController,
    orchestrator,
    rebalancingIndexes,
    guardShutdown,
    requireIndex,
    requireManager,
    mutationCtx,
    rebalanceCtx,
  } = core

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
      const mem = manager?.estimateMemoryBytes() ?? 0
      return {
        documentCount: manager?.countDocuments() ?? 0,
        partitionCount: manager?.partitionCount ?? 0,
        memoryBytes: mem,
        indexSizeBytes: mem,
        language: entry.language.name,
        schema: entry.config.schema,
      }
    },

    getPartitionStats(indexName: string): PartitionStatsResult[] {
      guardShutdown()
      requireIndex(indexName)
      return executor.getManager(indexName)?.getPartitionStats() ?? []
    },
    insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string> {
      return insertDocument(mutationCtx, indexName, document, docId, options)
    },
    insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult> {
      return insertDocumentBatch(mutationCtx, indexName, documents, options)
    },
    remove(indexName: string, docId: string): Promise<void> {
      return removeDocument(mutationCtx, indexName, docId)
    },
    removeBatch(indexName: string, docIds: string[]): Promise<BatchResult> {
      return removeDocumentBatch(mutationCtx, indexName, docIds)
    },
    update(indexName: string, docId: string, document: AnyDocument): Promise<void> {
      return updateDocument(mutationCtx, indexName, docId, document)
    },
    updateBatch(indexName: string, updates: Array<{ docId: string; document: AnyDocument }>): Promise<BatchResult> {
      return updateDocumentBatch(mutationCtx, indexName, updates)
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
        if (doc !== undefined) result.set(docId, doc)
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

      const resolvedParams = await resolveVectorText(params, entry.embeddingAdapter, abortController.signal)

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
      const resolvedParams = await resolveVectorText(params, entry.embeddingAdapter, abortController.signal)
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
      return executeSuggest(requireManager(indexName), requireIndex(indexName).language, params)
    },

    async snapshot(indexName: string): Promise<Uint8Array> {
      guardShutdown()
      return createSnapshot(requireManager(indexName), requireIndex(indexName))
    },

    async restore(indexName: string, data: Uint8Array): Promise<void> {
      guardShutdown()
      return restoreFromSnapshot(
        indexName,
        data,
        executor,
        indexRegistry,
        getVectorFieldPaths,
        narsil.dropIndex.bind(narsil),
        requireManager,
      )
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
      return executeRebalance(requireManager(indexName), indexName, targetPartitionCount, rebalanceCtx)
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
      if (!entry.config.partitions) entry.config.partitions = {}
      if (partitionConfig.maxDocsPerPartition !== undefined)
        entry.config.partitions.maxDocsPerPartition = partitionConfig.maxDocsPerPartition
      if (partitionConfig.maxPartitions !== undefined)
        entry.config.partitions.maxPartitions = partitionConfig.maxPartitions
    },

    getMemoryStats(): MemoryStats {
      const workerStats = orchestrator.getMemoryStats()
      let mainThreadBytes = 0
      for (const [name] of indexRegistry) {
        const mgr = executor.getManager(name)
        if (mgr) mainThreadBytes += mgr.estimateMemoryBytes()
      }
      return { totalBytes: mainThreadBytes + workerStats.totalBytes, workers: workerStats.workers }
    },

    async compactVectors(indexName: string, fieldName?: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      executeCompactVectors(requireManager(indexName), indexName, fieldName)
    },

    async optimizeVectors(indexName: string, fieldName?: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await executeOptimizeVectors(requireManager(indexName), indexName, fieldName)
    },

    vectorMaintenanceStatus(indexName: string): VectorMaintenanceResult[] {
      guardShutdown()
      requireIndex(indexName)
      return getVectorMaintenanceStatus(requireManager(indexName))
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
        if (handlers.size === 0) eventHandlers.delete(key)
      }
    },

    async shutdown(): Promise<void> {
      if (shutdownState.isShutdown) return
      shutdownState.isShutdown = true
      abortController.abort()

      for (const [name] of indexRegistry) {
        const mgr = executor.getManager(name)
        if (mgr) {
          for (const [, vecIdx] of mgr.getVectorIndexes()) {
            vecIdx.dispose()
          }
        }
      }

      if (flushManager) await flushManager.shutdown()
      const adaptersToShutdown = new Set<EmbeddingAdapter>()
      for (const [, entry] of indexRegistry) {
        if (entry.embeddingAdapter?.shutdown) adaptersToShutdown.add(entry.embeddingAdapter)
      }
      for (const adapter of adaptersToShutdown) {
        try {
          await adapter.shutdown?.()
        } catch (_) {
          /* best-effort */
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
