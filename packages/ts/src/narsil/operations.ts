import type { EngineCore, EventHandler } from '../engine/core'
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
import { executeRebalance } from '../engine/rebalance-executor'
import { createSnapshot, restoreFromSnapshot } from '../engine/snapshot'
import { validatePartitionConfig } from '../engine/validation'
import { getVectorFieldPaths } from '../engine/vector-fields'
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
  ListResult,
  MemoryStats,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
  VectorMaintenanceResult,
} from '../types/results'
import type { AnyDocument, IndexConfig, InsertOptions, PartitionConfig } from '../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../types/search'
import { runEngineListDocuments, runEnginePreflight, runEngineQuery, runEngineSuggest } from './reads'

export function createNarsilFromCore(core: EngineCore, config?: NarsilConfig): Narsil {
  const {
    executor,
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

  async function withOpenIndex<T>(indexName: string, action: () => Promise<T>): Promise<T> {
    guardShutdown()
    requireIndex(indexName)
    const release = await core.indexState.acquire(indexName)
    try {
      return await action()
    } finally {
      release()
    }
  }

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

    open(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      return core.indexState.open(indexName)
    },

    close(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      return core.indexState.close(indexName)
    },

    listIndexes(): IndexInfo[] {
      const infos: IndexInfo[] = []
      for (const [name, entry] of indexRegistry) {
        const manager = executor.getManager(name)
        infos.push({
          name,
          documentCount: manager?.countDocuments() ?? entry.documentCount,
          partitionCount: manager?.partitionCount ?? entry.partitionCount,
          language: entry.language.name,
          state: core.indexState.stateOf(name),
          reopenCount: core.indexState.reopenCount(name),
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
        documentCount: manager?.countDocuments() ?? entry.documentCount,
        partitionCount: manager?.partitionCount ?? entry.partitionCount,
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
      return withOpenIndex(indexName, () => insertDocument(mutationCtx, indexName, document, docId, options))
    },
    insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult> {
      return withOpenIndex(indexName, () => insertDocumentBatch(mutationCtx, indexName, documents, options))
    },
    remove(indexName: string, docId: string): Promise<void> {
      return withOpenIndex(indexName, () => removeDocument(mutationCtx, indexName, docId))
    },
    removeBatch(indexName: string, docIds: string[]): Promise<BatchResult> {
      return withOpenIndex(indexName, () => removeDocumentBatch(mutationCtx, indexName, docIds))
    },
    update(indexName: string, docId: string, document: AnyDocument): Promise<void> {
      return withOpenIndex(indexName, () => updateDocument(mutationCtx, indexName, docId, document))
    },
    updateBatch(indexName: string, updates: Array<{ docId: string; document: AnyDocument }>): Promise<BatchResult> {
      return withOpenIndex(indexName, () => updateDocumentBatch(mutationCtx, indexName, updates))
    },
    async get(indexName: string, docId: string): Promise<AnyDocument | undefined> {
      return withOpenIndex(indexName, () => executor.execute({ type: 'get', indexName, docId, requestId: docId }))
    },
    async getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>> {
      guardShutdown()
      requireIndex(indexName)
      return withOpenIndex(indexName, async () => {
        const result = new Map<string, AnyDocument>()
        for (const docId of docIds) {
          const doc = await executor.execute<AnyDocument | undefined>({
            type: 'get',
            indexName,
            docId,
            requestId: docId,
          })
          if (doc !== undefined) result.set(docId, doc)
        }
        return result
      })
    },
    async has(indexName: string, docId: string): Promise<boolean> {
      return withOpenIndex(indexName, () => executor.execute({ type: 'has', indexName, docId, requestId: docId }))
    },
    async countDocuments(indexName: string): Promise<number> {
      return withOpenIndex(indexName, () => executor.execute({ type: 'count', indexName, requestId: indexName }))
    },
    async listDocuments<T = AnyDocument>(indexName: string, params?: ListParams): Promise<ListResult<T>> {
      return runEngineListDocuments<T>(core, indexName, params ?? {})
    },
    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      return runEngineQuery<T>(core, indexName, params)
    },

    async preflight(indexName: string, params: QueryParams): Promise<PreflightResult> {
      return runEnginePreflight(core, indexName, params)
    },
    async suggest(indexName: string, params: SuggestParams): Promise<SuggestResult> {
      return runEngineSuggest(core, indexName, params)
    },

    async rebuildAnalysis(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await withOpenIndex(indexName, () => core.analysisRebuild.rebuild(indexName))
    },

    async snapshot(indexName: string): Promise<Uint8Array> {
      guardShutdown()
      return withOpenIndex(indexName, () => createSnapshot(requireManager(indexName), requireIndex(indexName)))
    },

    async restore(indexName: string, data: Uint8Array): Promise<void> {
      guardShutdown()
      await restoreFromSnapshot(indexName, data, {
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
        indexState: core.indexState,
      })
    },

    async checkpoint(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await withOpenIndex(indexName, async () => {
        if (durability) await durability.manager.checkpoint(indexName)
      })
    },

    async clear(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await withOpenIndex(indexName, async () => {
        await executor.execute({ type: 'clear', indexName, requestId: indexName })
        await orchestrator.replicateToWorkers({ type: 'clear', indexName, requestId: `replicate-clear-${indexName}` })
        core.watermarkNotifier.forget(indexName)
      })
    },

    async rebalance(indexName: string, targetPartitionCount: number): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      return withOpenIndex(indexName, () =>
        executeRebalance(requireManager(indexName), indexName, targetPartitionCount, rebalanceCtx),
      )
    },

    async updatePartitionConfig(indexName: string, partitionConfig: Partial<PartitionConfig>): Promise<void> {
      guardShutdown()
      return withOpenIndex(indexName, async () => {
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
      })
    },

    async getMemoryStats(): Promise<MemoryStats> {
      let estimatedIndexBytes = 0
      for (const [name] of indexRegistry) {
        estimatedIndexBytes += executor.getManager(name)?.estimateMemoryBytes() ?? 0
      }
      const workers = await orchestrator.getWorkerMemoryStats()
      const lifecycleCounts = core.indexState.counts()
      return {
        process: readProcessMemory(),
        estimatedIndexBytes,
        openIndexCount: lifecycleCounts.open,
        closedIndexCount: lifecycleCounts.closed,
        reopenCount: lifecycleCounts.reopens,
        workers,
      }
    },

    async compactVectors(indexName: string, fieldName?: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await withOpenIndex(indexName, async () => {
        executeCompactVectors(requireManager(indexName), indexName, fieldName)
      })
    },

    async optimizeVectors(indexName: string, fieldName?: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await withOpenIndex(indexName, () => executeOptimizeVectors(requireManager(indexName), indexName, fieldName))
    },

    vectorMaintenanceStatus(indexName: string): VectorMaintenanceResult[] {
      guardShutdown()
      requireIndex(indexName)
      const manager = executor.getManager(indexName)
      return manager === undefined ? [] : getVectorMaintenanceStatus(manager)
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
