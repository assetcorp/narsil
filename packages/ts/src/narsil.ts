import { generateId } from './core/id-generator'
import { createWorkerOrchestrator } from './engine/orchestration'
import { executePreflight, executeQuery } from './engine/query'
import { BATCH_CHUNK_SIZE, validateDocId, validateIndexName } from './engine/validation'
import { ErrorCodes, NarsilError } from './errors'
import { getLanguage } from './languages/registry'
import { createFlushManager, type FlushManager } from './persistence/flush-manager'
import { createPluginRegistry, type PluginRegistry } from './plugins/registry'
import { validateSchema } from './schema/validator'
import type { NarsilConfig } from './types/config'
import type { NarsilEventMap } from './types/events'
import type { LanguageModule } from './types/language'
import type { BatchResult, IndexInfo, IndexStats, MemoryStats, PreflightResult, QueryResult } from './types/results'
import type { AnyDocument, IndexConfig, InsertOptions } from './types/schema'
import type { QueryParams } from './types/search'
import { createDirectExecutor, type DirectExecutorExtensions } from './workers/direct-executor'
import type { Executor } from './workers/executor'
import { createExecutionPromoter } from './workers/promoter'

export interface Narsil {
  createIndex(name: string, config: IndexConfig): Promise<void>
  dropIndex(name: string): Promise<void>
  listIndexes(): IndexInfo[]
  getStats(indexName: string): IndexStats

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

  clear(indexName: string): Promise<void>
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

  const orchestrator = createWorkerOrchestrator(config, executor, promoter, indexRegistry)

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
      return {
        documentCount: manager?.countDocuments() ?? 0,
        partitionCount: manager?.partitionCount ?? 0,
        memoryBytes: 0,
        indexSizeBytes: 0,
        language: entry.language.name,
        schema: entry.config.schema,
      }
    },

    async insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string> {
      guardShutdown()
      requireIndex(indexName)

      const resolvedDocId = docId ?? idGenerator()
      validateDocId(resolvedDocId)

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

      orchestrator.checkPromotion()

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
      orchestrator.checkPromotion()

      return { succeeded, failed }
    },

    async remove(indexName: string, docId: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      validateDocId(docId)

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

    async clear(indexName: string): Promise<void> {
      guardShutdown()
      requireIndex(indexName)
      await executor.execute({ type: 'clear', indexName, requestId: indexName })
      await orchestrator.replicateToWorkers({ type: 'clear', indexName, requestId: `replicate-clear-${indexName}` })
    },

    getMemoryStats(): MemoryStats {
      return orchestrator.getMemoryStats()
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
