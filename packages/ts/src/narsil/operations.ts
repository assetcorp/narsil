import {
  dropEngineIndex,
  insertDocument,
  insertDocumentBatch,
  removeDocument,
  removeDocumentBatch,
  updateDocument,
  updateDocumentBatch,
} from '#platform/memory-guarded-writes'
import { countWrite } from '#platform/turn-budget'
import { clearEngineIndex } from '../engine/clear-index'
import type { EngineCore, EventHandler } from '../engine/core'
import { createEngineIndex, registerEngineEmbeddingAdapter } from '../engine/index-lifecycle'
import { shutdownEngine } from '../engine/lifecycle'
import { loadOptionalWrites } from '../engine/optional-writes-code'
import { withRenewedSyncEpoch } from '../engine/sync-epoch'
import { emitWriteEventAfter } from '../engine/write-events'
import { loadStorageCode } from '../persistence/storage-code'
import { registerEngineRerankAdapter } from '../rerank/registry'
import type { EmbeddingAdapter, RerankAdapter } from '../types/adapters'
import type { AnalysisChange } from '../types/analysis-operations'
import type { NarsilConfig } from '../types/config'
import type { Narsil } from '../types/engine'
import type { NarsilEventMap } from '../types/events'
import type { MemoryStats } from '../types/memory'
import type {
  BatchResult,
  IndexInfo,
  IndexStats,
  ListResult,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
  VectorMaintenanceResult,
} from '../types/results'
import type { AnyDocument, IndexConfig, InsertOptions, PartitionConfig, WriteOptions } from '../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../types/search'
import { loadedVectorCode, loadVectorCode } from '../workers/vector-code'
import { bm25Operations } from './bm25'
import { changesOperations } from './changes'
import { bindEngineCore, queryReadOptionsOf } from './internals'
import { portabilityOperations } from './portability'
import { runEngineListDocuments, runEnginePreflight, runEngineQuery, runEngineSuggest } from './reads'
import { syncOperations } from './sync'
import { synonymOperations } from './synonyms'

export function createNarsilFromCore(core: EngineCore, config?: NarsilConfig): Narsil {
  const {
    executor,
    durability,
    indexRegistry,
    eventHandlers,
    shutdownState,
    abortController,
    orchestrator,
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

  const rebalancesStarting = new Map<string, Promise<void>>()

  function withOpenIndexWrite<T>(indexName: string, action: () => Promise<T>): Promise<T> {
    const starting = rebalancesStarting.get(indexName)
    const written =
      starting === undefined ? withOpenIndex(indexName, action) : starting.then(() => withOpenIndex(indexName, action))
    return emitWriteEventAfter(core, indexName, written)
  }

  function withCountedWrite<T>(indexName: string, action: () => Promise<T>): Promise<T> {
    return countWrite(() => withOpenIndexWrite(indexName, action))
  }

  const narsil: Narsil = {
    createIndex(name: string, indexConfig: IndexConfig): Promise<void> {
      return emitWriteEventAfter(
        core,
        name,
        createEngineIndex(core, config, name, indexConfig, { appliesCreationLimits: true }),
      )
    },

    registerEmbeddingAdapter(name: string, adapter: EmbeddingAdapter): void {
      registerEngineEmbeddingAdapter(core, name, adapter)
    },

    registerRerankAdapter(name: string, adapter: RerankAdapter): void {
      registerEngineRerankAdapter(core, name, adapter)
    },

    dropIndex(name: string): Promise<void> {
      return emitWriteEventAfter(core, name, dropEngineIndex(core, name))
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
        savedBytes: entry.storedSizes?.savedBytes,
        logBytes: entry.storedSizes?.logBytes,
        language: entry.language.name,
        schema: entry.config.schema,
        heldSearchStates: manager?.heldSearchStates ?? 0,
      }
    },

    getPartitionStats(indexName: string): PartitionStatsResult[] {
      guardShutdown()
      const entry = requireIndex(indexName)
      const stats = executor.getManager(indexName)?.getPartitionStats() ?? []
      entry.storedSizes?.addTo(stats)
      return stats
    },
    insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string> {
      return withCountedWrite(indexName, () => insertDocument(mutationCtx, indexName, document, docId, options))
    },
    insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult> {
      return withCountedWrite(indexName, () => insertDocumentBatch(mutationCtx, indexName, documents, options))
    },
    remove(indexName: string, docId: string, options?: WriteOptions): Promise<void> {
      return withCountedWrite(indexName, () => removeDocument(mutationCtx, indexName, docId, options))
    },
    removeBatch(indexName: string, docIds: string[], options?: WriteOptions): Promise<BatchResult> {
      return withCountedWrite(indexName, () => removeDocumentBatch(mutationCtx, indexName, docIds, options))
    },
    update(indexName: string, docId: string, document: AnyDocument, options?: WriteOptions): Promise<void> {
      return withCountedWrite(indexName, () => updateDocument(mutationCtx, indexName, docId, document, options))
    },
    updateBatch(
      indexName: string,
      updates: Array<{ docId: string; document: AnyDocument }>,
      options?: WriteOptions,
    ): Promise<BatchResult> {
      return withCountedWrite(indexName, () => updateDocumentBatch(mutationCtx, indexName, updates, options))
    },
    waitForWrites(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      return orchestrator.awaitWrites(indexName)
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
      return runEngineQuery<T>(core, indexName, params, queryReadOptionsOf(params))
    },

    async preflight(indexName: string, params: QueryParams): Promise<PreflightResult> {
      return runEnginePreflight(core, indexName, params, queryReadOptionsOf(params))
    },
    async suggest(indexName: string, params: SuggestParams): Promise<SuggestResult> {
      return runEngineSuggest(core, indexName, params)
    },

    async rebuildAnalysis(indexName: string): Promise<void> {
      guardShutdown()
      const entry = requireIndex(indexName)
      await withOpenIndexWrite(indexName, async () => {
        if (entry.pendingAnalysis === null) return core.analysisRebuild.rebuild(indexName)
        const [{ resumeAnalysisChange }] = await Promise.all([loadStorageCode(), loadOptionalWrites()])
        return resumeAnalysisChange(core, indexName)
      })
    },

    async changeAnalysis(indexName: string, change: AnalysisChange): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      const changed = withOpenIndex(indexName, async () => {
        const [{ changeIndexAnalysis }] = await Promise.all([loadStorageCode(), loadOptionalWrites()])
        return changeIndexAnalysis(core, indexName, change)
      })
      await emitWriteEventAfter(core, indexName, changed)
    },

    ...portabilityOperations(core, config, () => narsil),
    ...synonymOperations(core),
    ...bm25Operations(core),
    ...syncOperations(core),
    ...changesOperations(core),

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
      await withOpenIndexWrite(indexName, () => clearEngineIndex(core, indexName))
    },

    async rebalance(indexName: string, targetPartitionCount: number): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      let writesMayFollow: () => void = () => undefined
      const started = new Promise<void>(resolve => {
        writesMayFollow = resolve
      })
      function releaseWrites(): void {
        writesMayFollow()
        if (rebalancesStarting.get(indexName) === started) rebalancesStarting.delete(indexName)
      }
      rebalancesStarting.set(indexName, started)
      const rebalanced = withOpenIndex(indexName, () =>
        withRenewedSyncEpoch(core, indexName, async () => {
          const [{ executeRebalance }] = await Promise.all([loadStorageCode(), loadOptionalWrites()])
          const running = executeRebalance(requireManager(indexName), indexName, targetPartitionCount, rebalanceCtx)
          releaseWrites()
          await running
        }),
      )
      return emitWriteEventAfter(core, indexName, rebalanced).finally(releaseWrites)
    },

    async updatePartitionConfig(indexName: string, partitionConfig: Partial<PartitionConfig>): Promise<void> {
      guardShutdown()
      return withOpenIndex(indexName, async () => {
        const { updateEnginePartitionConfig } = await loadOptionalWrites()
        await updateEnginePartitionConfig(core, indexName, partitionConfig)
      })
    },

    async getMemoryStats(): Promise<MemoryStats> {
      let estimatedIndexBytes = 0
      for (const [name] of indexRegistry) {
        estimatedIndexBytes += executor.getManager(name)?.estimateMemoryBytes() ?? 0
      }
      const workers = await orchestrator.getWorkerMemoryStats()
      const { readProcessMemory } = await loadOptionalWrites()
      const lifecycleCounts = core.indexState.counts()
      return {
        process: readProcessMemory(),
        estimatedIndexBytes,
        openIndexCount: lifecycleCounts.open,
        closedIndexCount: lifecycleCounts.closed,
        reopenCount: lifecycleCounts.reopens,
        workerCopies: orchestrator.workerCopies(),
        heldCheckpoints: durability?.manager.heldCheckpoints?.() ?? [],
        workers,
      }
    },

    async compactVectors(indexName: string, fieldName?: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      const { compactVectors } = await loadVectorCode()
      await withOpenIndexWrite(indexName, async () => {
        compactVectors(requireManager(indexName), indexName, fieldName)
      })
    },

    async optimizeVectors(indexName: string, fieldName?: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      const { optimizeVectors } = await loadVectorCode()
      await withOpenIndexWrite(indexName, () => optimizeVectors(requireManager(indexName), indexName, fieldName))
    },

    vectorMaintenanceStatus(indexName: string): VectorMaintenanceResult[] {
      guardShutdown()
      requireIndex(indexName)
      const manager = executor.getManager(indexName)
      const vectorCode = loadedVectorCode()
      return manager === undefined || vectorCode === null ? [] : vectorCode.getVectorMaintenanceStatus(manager)
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

  bindEngineCore(narsil, core)
  return narsil
}
