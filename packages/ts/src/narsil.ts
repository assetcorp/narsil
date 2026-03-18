import { generateId } from './core/id-generator'
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
import { validateSchema } from './schema/validator'
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
  SnapshotData,
} from './types/results'
import type { AnyDocument, IndexConfig, InsertOptions, PartitionConfig } from './types/schema'
import type { QueryParams } from './types/search'
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

  snapshot(indexName: string): Promise<SnapshotData>
  restore(indexName: string, data: SnapshotData): Promise<void>

  clear(indexName: string): Promise<void>
  rebalance(indexName: string, targetPartitionCount: number): Promise<void>
  updatePartitionConfig(indexName: string, config: Partial<PartitionConfig>): Promise<void>
  getMemoryStats(): MemoryStats

  on<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  off<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  shutdown(): Promise<void>
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
  const indexRegistry = new Map<string, { config: IndexConfig; language: LanguageModule }>()
  type EventHandler = (payload: unknown) => void
  const eventHandlers = new Map<string, Set<EventHandler>>()
  let isShutdown = false

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

  function requireIndex(indexName: string): { config: IndexConfig; language: LanguageModule } {
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
    waq.push(entry)
    return true
  }

  function requireManager(indexName: string) {
    const manager = executor.getManager(indexName)
    if (!manager) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" manager not found`, { indexName })
    }
    return manager
  }

  const narsil: Narsil = {
    async createIndex(name: string, indexConfig: IndexConfig): Promise<void> {
      guardShutdown()
      validateIndexName(name)

      if (indexRegistry.has(name)) {
        throw new NarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, `Index "${name}" already exists`, { indexName: name })
      }

      validateSchema(indexConfig.schema)

      const language = getLanguage(indexConfig.language ?? 'english')
      executor.createIndex(name, indexConfig, language)
      indexRegistry.set(name, { config: indexConfig, language })

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
      requireIndex(indexName)

      const resolvedDocId = docId ?? idGenerator()
      validateDocId(resolvedDocId)

      if (bufferIfRebalancing(indexName, { action: 'insert', docId: resolvedDocId, document, indexName })) {
        return resolvedDocId
      }

      await pluginRegistry.runHook('beforeInsert', { indexName, docId: resolvedDocId, document })

      await executor.execute({
        type: 'insert',
        indexName,
        docId: resolvedDocId,
        document,
        requestId: resolvedDocId,
        skipClone: options?.skipClone,
      })

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
      requireIndex(indexName)

      const succeeded: string[] = []
      const failed: BatchResult['failed'] = []
      const hasBeforeHook = pluginRegistry.hasHooks('beforeInsert')
      const hasAfterHook = pluginRegistry.hasHooks('afterInsert')

      for (let chunkStart = 0; chunkStart < documents.length; chunkStart += BATCH_CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, documents.length)

        for (let i = chunkStart; i < chunkEnd; i++) {
          const docId = idGenerator()
          try {
            validateDocId(docId)

            if (hasBeforeHook) {
              await pluginRegistry.runHook('beforeInsert', { indexName, docId, document: documents[i] })
            }

            const result = executor.execute({
              type: 'insert',
              indexName,
              docId,
              document: documents[i],
              requestId: docId,
              skipClone: options?.skipClone,
            })
            if (result && typeof (result as Promise<unknown>).then === 'function') {
              await result
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
      requireIndex(indexName)
      validateDocId(docId)

      if (bufferIfRebalancing(indexName, { action: 'update', docId, document, indexName })) {
        return
      }

      const manager = executor.getManager(indexName)
      const oldDocument = manager?.get(docId)

      await pluginRegistry.runHook('beforeUpdate', {
        indexName,
        docId,
        oldDocument: oldDocument ?? ({} as AnyDocument),
        newDocument: document,
      })

      await executor.execute({ type: 'update', indexName, docId, document, requestId: docId })

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

      await pluginRegistry.runHook('beforeSearch', { indexName, params })

      const workerSearch = orchestrator.isPromoted() ? orchestrator.searchViaWorker.bind(orchestrator) : undefined

      const result = await executeQuery<T>(params, {
        manager,
        language: entry.language,
        config: entry.config,
        workerSearch,
        indexName,
      })

      try {
        await pluginRegistry.runHook('afterSearch', {
          indexName,
          params,
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

      const workerSearch = orchestrator.isPromoted() ? orchestrator.searchViaWorker.bind(orchestrator) : undefined

      return executePreflight(params, {
        manager,
        language: entry.language,
        config: entry.config,
        workerSearch,
        indexName,
      })
    },

    async snapshot(indexName: string): Promise<SnapshotData> {
      guardShutdown()
      const entry = requireIndex(indexName)
      const manager = requireManager(indexName)

      const partitions = []
      for (let i = 0; i < manager.partitionCount; i++) {
        partitions.push(manager.serializePartition(i))
      }

      return {
        version: 1,
        indexName,
        schema: entry.config.schema,
        language: entry.language.name,
        partitions,
      }
    },

    async restore(indexName: string, data: SnapshotData): Promise<void> {
      guardShutdown()

      if (typeof data !== 'object' || data === null || !Array.isArray(data.partitions)) {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot data: missing partitions array')
      }

      if (data.version !== 1) {
        throw new NarsilError(
          ErrorCodes.DOC_VALIDATION_FAILED,
          `Unsupported snapshot version: ${data.version}. Expected version 1`,
          { version: data.version },
        )
      }

      if (!data.schema || typeof data.schema !== 'object') {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot data: missing or invalid schema')
      }

      if (!data.language || typeof data.language !== 'string') {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot data: missing or invalid language')
      }

      const language = getLanguage(data.language)
      validateSchema(data.schema as import('./types/schema').SchemaDefinition)

      if (indexRegistry.has(indexName)) {
        await narsil.dropIndex(indexName)
      }

      const schema = data.schema as import('./types/schema').SchemaDefinition
      const indexConfig: IndexConfig = { schema, language: data.language }

      executor.createIndex(indexName, indexConfig, language)
      indexRegistry.set(indexName, { config: indexConfig, language })

      try {
        const manager = requireManager(indexName)

        while (manager.partitionCount < data.partitions.length) {
          manager.addPartition()
        }

        for (let i = 0; i < data.partitions.length; i++) {
          manager.deserializePartition(i, data.partitions[i])
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
        for (const entry of entries) {
          const partitionLastSeq = appliedSeqs.get(0) ?? 0
          if (entry.sequenceNumber <= partitionLastSeq) continue

          try {
            if (entry.action === 'insert' && entry.document) {
              manager.insert(entry.docId, entry.document)
            } else if (entry.action === 'remove') {
              manager.remove(entry.docId)
            } else if (entry.action === 'update' && entry.document) {
              manager.update(entry.docId, entry.document)
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

      if (flushManager) {
        await flushManager.shutdown()
      }

      await orchestrator.shutdown()
      await executor.shutdown()
      eventHandlers.clear()
      indexRegistry.clear()
    },
  }

  return narsil
}
