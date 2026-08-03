import { type EngineCore, type EventHandler, getVectorFieldPaths } from '../engine/core'
import { createEngineIndex, dropEngineIndex, registerEngineEmbeddingAdapter } from '../engine/index-lifecycle'
import { shutdownEngine } from '../engine/lifecycle'
import {
  insertDocument,
  insertDocumentBatch,
  removeDocument,
  removeDocumentBatch,
  updateDocument,
  updateDocumentBatch,
} from '../engine/mutations'
import { executePreflight, executeQuery } from '../engine/query'
import { executeRebalance } from '../engine/rebalance-executor'
import { resolveVectorText } from '../engine/resolve-vector-text'
import { createSnapshot, restoreFromSnapshot } from '../engine/snapshot'
import { executeSuggest } from '../engine/suggest'
import { validatePartitionConfig } from '../engine/validation'
import {
  compactVectors as executeCompactVectors,
  optimizeVectors as executeOptimizeVectors,
  getVectorMaintenanceStatus,
} from '../engine/vector-maintenance'
import { ErrorCodes, NarsilError } from '../errors'
import { readProcessMemory } from '../runtime/process-memory'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { Narsil } from '../types/engine'
import type { NarsilEventMap } from '../types/events'
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
} from '../types/results'
import type { AnyDocument, IndexConfig, InsertOptions, PartitionConfig } from '../types/schema'
import type { QueryParams, SuggestParams } from '../types/search'

export function createNarsilFromCore(core: EngineCore, config?: NarsilConfig): Narsil {
  const {
    executor,
    pluginRegistry,
    durability,
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

  const invalidation = core.invalidation
  const broadcastStats = invalidation === null ? undefined : (name: string) => invalidation.broadcastStats(name)

  const narsil: Narsil = {
    createIndex(name: string, indexConfig: IndexConfig): Promise<void> {
      return createEngineIndex(core, config, name, indexConfig)
    },

    registerEmbeddingAdapter(name: string, adapter: EmbeddingAdapter): void {
      registerEngineEmbeddingAdapter(core, name, adapter)
    },

    dropIndex(name: string): Promise<void> {
      return dropEngineIndex(core, name)
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
          ...(core.analysisRebuild.isStale(name) ? { analysisStale: true } : {}),
        })
      }
      return infos
    },

    getStats(indexName: string): IndexStats {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = executor.getManager(indexName)
      return {
        documentCount: manager?.countDocuments() ?? 0,
        partitionCount: manager?.partitionCount ?? 0,
        estimatedMemoryBytes: manager?.estimateMemoryBytes() ?? 0,
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

      const resolvedParams = await resolveVectorText(
        params,
        entry.embeddingAdapter,
        abortController.signal,
        entry.embeddingAdapterName,
      )

      await pluginRegistry.runHook('beforeSearch', { indexName, params: resolvedParams })

      const workerSearch = orchestrator.isPromoted() ? orchestrator.searchViaWorker.bind(orchestrator) : undefined

      const result = await executeQuery<T>(resolvedParams, {
        manager,
        language: entry.language,
        config: entry.config,
        workerSearch,
        indexName,
        broadcastStats,
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

      if (core.analysisRebuild.isStale(indexName)) {
        result.analysisStale = true
      }

      return result
    },

    async preflight(indexName: string, params: QueryParams): Promise<PreflightResult> {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = requireManager(indexName)
      const resolvedParams = await resolveVectorText(
        params,
        entry.embeddingAdapter,
        abortController.signal,
        entry.embeddingAdapterName,
      )
      const workerSearch = orchestrator.isPromoted() ? orchestrator.searchViaWorker.bind(orchestrator) : undefined
      const result = await executePreflight(resolvedParams, {
        manager,
        language: entry.language,
        config: entry.config,
        workerSearch,
        indexName,
        broadcastStats,
      })
      if (core.analysisRebuild.isStale(indexName)) {
        result.analysisStale = true
      }
      return result
    },
    async suggest(indexName: string, params: SuggestParams): Promise<SuggestResult> {
      guardShutdown()
      const result = await executeSuggest(requireManager(indexName), requireIndex(indexName).language, params)
      if (core.analysisRebuild.isStale(indexName)) {
        result.analysisStale = true
      }
      return result
    },

    async rebuildAnalysis(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await core.analysisRebuild.rebuild(indexName)
    },

    async snapshot(indexName: string): Promise<Uint8Array> {
      guardShutdown()
      return createSnapshot(requireManager(indexName), requireIndex(indexName))
    },

    async restore(indexName: string, data: Uint8Array): Promise<void> {
      guardShutdown()
      return restoreFromSnapshot(indexName, data, {
        executor,
        indexRegistry,
        getVectorFieldPaths,
        dropIndex: narsil.dropIndex.bind(narsil),
        requireManager,
        durability,
        embeddingAdapters: core.embeddingAdapters,
        defaultEmbeddingAdapter: config?.embedding ?? null,
        markAnalysisStale: core.analysisRebuild.markStale,
        clearAnalysisStale: core.analysisRebuild.clearStale,
      })
    },

    async checkpoint(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      if (durability) {
        await durability.manager.checkpoint(indexName)
      }
    },

    async clear(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await executor.execute({ type: 'clear', indexName, requestId: indexName })
      await orchestrator.replicateToWorkers({ type: 'clear', indexName, requestId: `replicate-clear-${indexName}` })
      core.watermarkNotifier.forget(indexName)
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
      validatePartitionConfig(partitionConfig)
      if (partitionConfig.maxPartitions !== undefined && partitionConfig.maxPartitions < manager.partitionCount) {
        throw new NarsilError(
          ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
          `maxPartitions (${partitionConfig.maxPartitions}) is less than the current partition count (${manager.partitionCount})`,
          { maxPartitions: partitionConfig.maxPartitions, partitionCount: manager.partitionCount },
        )
      }
      const currentDocCount = manager.countDocuments()
      const newMaxDocs = partitionConfig.maxDocsPerPartition ?? entry.config.partitions?.maxDocsPerPartition
      if (newMaxDocs !== undefined) {
        const newTotalCapacity = newMaxDocs * manager.partitionCount
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
      if (partitionConfig.watermark !== undefined) entry.config.partitions.watermark = partitionConfig.watermark
      if (durability) await durability.manager.persistMetadata(indexName)
      core.watermarkNotifier.check(indexName)
    },

    async getMemoryStats(): Promise<MemoryStats> {
      let estimatedIndexBytes = 0
      for (const [name] of indexRegistry) {
        estimatedIndexBytes += executor.getManager(name)?.estimateMemoryBytes() ?? 0
      }
      const workers = await orchestrator.getWorkerMemoryStats()
      return { process: readProcessMemory(), estimatedIndexBytes, workers }
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
      await shutdownEngine(core)
    },
  }

  return narsil
}
