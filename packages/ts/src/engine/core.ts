import { generateId } from '../core/id-generator'
import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import type { PartitionManager } from '../partitioning/manager'
import { createRebalancer, type Rebalancer } from '../partitioning/rebalancer'
import { createPartitionRouter, type PartitionRouter } from '../partitioning/router'
import type { createWriteAheadQueue, WAQEntry } from '../partitioning/write-ahead-queue'
import { createPluginRegistry, type PluginRegistry } from '../plugins/registry'
import { validateEmbeddingConfig, validateRegisteredAdapter } from '../schema/embedding-validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import { createDirectExecutor, type DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import { resolveWorkerCount, splitWorkerBudget } from '../workers/pool'
import { type AnalysisRebuildCoordinator, wireAnalysisRebuild } from './analysis-rebuild'
import { resolveDurabilityTier } from './durability-config'
import type { DurabilityIntegration } from './durability-integration'
import { createDurabilityFromTier } from './durability-wiring'
import type { IndexStateCoordinator } from './index-state'
import { type EngineCoreHooks, wireIndexState } from './index-state-wiring'
import { createInvalidationFromConfig, type InvalidationIntegration } from './invalidation'
import type { MutationContext } from './mutations'
import { createWorkerOrchestrator, type WorkerOrchestrator, workersEnabledByDefault } from './orchestration'
import type { RebalanceContext } from './rebalance-executor'
import { reconstructSchemaFromMetadata } from './recovery-schema'
import { validateWorkerConfig } from './validation'
import { getVectorFieldPaths } from './vector-fields'
import { createWatermarkNotifier, type WatermarkNotifier } from './watermark'

export type IndexRegistryEntry = {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
  /** Registry name the adapter was resolved from; lets durability metadata
   * persist the binding and lets late registration rebind recovered indexes. */
  embeddingAdapterName: string | null
  vectorFieldPaths: Set<string>
  /** The identity the cluster gave this index, or null where no cluster owns it. */
  indexUuid: string | null
  /** The partitions this copy holds, or null where nothing has recorded them yet. */
  heldPartitions: number[] | null
  documentCount: number
  partitionCount: number
}

export type EventHandler = (payload: unknown) => void

export interface EngineCore {
  readonly executor: Executor & DirectExecutorExtensions
  readonly pluginRegistry: PluginRegistry
  readonly durability: DurabilityIntegration | null
  readonly invalidation: InvalidationIntegration | null
  readonly idGenerator: () => string
  readonly indexRegistry: Map<string, IndexRegistryEntry>
  readonly embeddingAdapters: Map<string, EmbeddingAdapter>
  readonly eventHandlers: Map<string, Set<EventHandler>>
  readonly shutdownState: { isShutdown: boolean }
  readonly abortController: AbortController
  readonly orchestrator: WorkerOrchestrator
  readonly rebalancer: Rebalancer
  readonly rebalanceRouter: PartitionRouter
  readonly rebalancingIndexes: Set<string>
  readonly waqMap: Map<string, ReturnType<typeof createWriteAheadQueue>>
  readonly guardShutdown: () => void
  readonly requireIndex: (indexName: string) => IndexRegistryEntry
  readonly requireManager: (indexName: string) => PartitionManager
  readonly bufferIfRebalancing: (indexName: string, entry: Omit<WAQEntry, 'sequenceNumber'>) => boolean
  readonly watermarkNotifier: WatermarkNotifier
  readonly analysisRebuild: AnalysisRebuildCoordinator
  readonly indexState: IndexStateCoordinator
  readonly mutationCtx: MutationContext
  readonly rebalanceCtx: RebalanceContext
}

/**
 * Builds the internal engine services shared by standalone and cluster engines.
 *
 * @param config - Public engine settings.
 * @param hooks - Node-local callbacks the engine runs after an index reopens and after it closes.
 * @returns The connected engine core.
 */
export function createEngineCore(config?: NarsilConfig, hooks?: EngineCoreHooks): EngineCore {
  validateWorkerConfig(config?.workers, config?.lifecycle)
  const vectorWorkerCount = splitWorkerBudget(resolveWorkerCount(config?.workers?.count)).vector
  const executor: Executor & DirectExecutorExtensions = createDirectExecutor({
    vectorWorkerCopies: {
      enabled: (config?.workers?.enabled ?? workersEnabledByDefault()) && vectorWorkerCount > 0,
      count: vectorWorkerCount,
    },
  })

  const pluginRegistry: PluginRegistry = createPluginRegistry()
  if (config?.plugins) {
    for (const plugin of config.plugins) pluginRegistry.register(plugin)
  }

  const idGenerator = config?.idGenerator ?? generateId
  const indexRegistry = new Map<string, IndexRegistryEntry>()
  const embeddingAdapters = new Map<string, EmbeddingAdapter>()
  if (config?.embeddingAdapters) {
    for (const [name, adapter] of Object.entries(config.embeddingAdapters)) {
      validateRegisteredAdapter(name, adapter)
      embeddingAdapters.set(name, adapter)
    }
  }
  const eventHandlers = new Map<string, Set<EventHandler>>()
  const shutdownState = { isShutdown: false }
  const abortController = new AbortController()
  const rebalancingIndexes = new Set<string>()

  const orchestrator = createWorkerOrchestrator(config, executor, indexRegistry, {
    shouldDeferCopies() {
      return rebalancingIndexes.size > 0
    },
    onCopiesLoaded(workerCount, reason) {
      const handlers = eventHandlers.get('workerPromote')
      if (handlers) {
        for (const handler of handlers) handler({ workerCount, reason })
      }
      void Promise.resolve(pluginRegistry.runHook('onWorkerPromote', { workerCount, reason })).catch((err: unknown) => {
        console.warn('onWorkerPromote plugin hook failed:', err instanceof Error ? err.message : String(err))
      })
    },
    onCopyLoadFailure(reason, error, retryable) {
      const handlers = eventHandlers.get('workerPromoteFailure')
      if (!handlers || handlers.size === 0) {
        console.warn(`Loading worker copies failed (${reason}):`, error)
        return
      }
      for (const handler of handlers) handler({ reason, error, retryable })
    },
    onWorkerCrash(workerId, indexNames, error) {
      const handlers = eventHandlers.get('workerCrash')
      if (!handlers || handlers.size === 0) {
        console.warn(`Worker ${workerId} crashed:`, error)
        return
      }
      for (const handler of handlers) handler({ workerId, indexNames, error })
    },
  })

  const rebalancer = createRebalancer()
  const rebalanceRouter = createPartitionRouter()
  const waqMap = new Map<string, ReturnType<typeof createWriteAheadQueue>>()
  const rebalanceTargets = new Map<string, number>()

  function guardShutdown(): void {
    if (shutdownState.isShutdown) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'This Narsil instance has been shut down')
    }
  }

  function requireIndex(indexName: string): IndexRegistryEntry {
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
    const clonedEntry = entry.document ? { ...entry, document: structuredClone(entry.document) } : entry
    waq.push(clonedEntry)
    return true
  }

  function requireManager(indexName: string): PartitionManager {
    const manager = executor.getManager(indexName)
    if (!manager) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" manager not found`, { indexName })
    }
    return manager
  }

  async function createIndexFromMetadata(metadata: IndexMetadata, loadData: boolean): Promise<void> {
    const existing = indexRegistry.get(metadata.indexName)
    if (existing !== undefined) {
      if (loadData && executor.getManager(metadata.indexName) === undefined) {
        executor.createIndex(metadata.indexName, existing.config, existing.language)
      }
      return
    }
    const indexConfig = reconstructSchemaFromMetadata(metadata)
    const language = getLanguage(indexConfig.language ?? 'english')

    const adapterName = metadata.embedding?.adapter ?? null
    let embeddingAdapter: EmbeddingAdapter | null = null
    if (metadata.embedding) {
      const candidate =
        adapterName !== null ? (embeddingAdapters.get(adapterName) ?? null) : (config?.embedding ?? null)
      if (candidate) {
        try {
          validateEmbeddingConfig(
            { fields: metadata.embedding.fields, adapter: candidate },
            indexConfig.schema,
            undefined,
          )
        } catch (err) {
          if (err instanceof NarsilError) {
            throw new NarsilError(err.code, `Recovery of index "${metadata.indexName}" failed: ${err.message}`, {
              indexName: metadata.indexName,
              adapter: adapterName ?? undefined,
            })
          }
          throw err
        }
        embeddingAdapter = candidate
      }
    }

    try {
      if (loadData) executor.createIndex(metadata.indexName, indexConfig, language)
    } catch (err) {
      if (err instanceof NarsilError && err.code === ErrorCodes.CONFIG_INVALID) {
        throw new NarsilError(err.code, `Recovery of index "${metadata.indexName}" failed: ${err.message}`, {
          indexName: metadata.indexName,
          tokenizer: metadata.tokenizer,
          stopWords: metadata.stopWords,
        })
      }
      throw err
    }
    indexRegistry.set(metadata.indexName, {
      config: indexConfig,
      language,
      embeddingAdapter,
      embeddingAdapterName: adapterName,
      vectorFieldPaths: getVectorFieldPaths(indexConfig.schema),
      indexUuid: metadata.indexUuid ?? null,
      heldPartitions: metadata.heldPartitions ?? null,
      documentCount: metadata.documentCount ?? 0,
      partitionCount: metadata.partitionCount,
    })
    if (loadData) await indexState.registerOpen(metadata.indexName)
    else indexState.registerClosed(metadata.indexName)
    if (metadata.analysisRevision !== language.revision) {
      analysisRebuild.markStale({
        indexName: metadata.indexName,
        language: language.name,
        storedRevision: metadata.analysisRevision ?? null,
        currentRevision: language.revision,
      })
    }
  }

  const durabilityTier = config !== undefined ? resolveDurabilityTier(config) : null
  if (config?.lifecycle !== undefined && durabilityTier === null) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Index lifecycle settings require durability')
  }
  let invalidation: InvalidationIntegration | null = null

  const durability = createDurabilityFromTier(durabilityTier, {
    getManager: indexName => executor.getManager(indexName),
    indexRegistry,
    createIndexFromMetadata,
    emitFatalError(error: Error) {
      const handlers = eventHandlers.get('durabilityError')
      if (handlers) {
        for (const handler of handlers) handler({ error })
      }
    },
    publishCheckpointedPartitions: (indexName, partitions) =>
      invalidation?.publishPartitions(indexName, partitions) ?? Promise.resolve(),
    recordCheckpoint(indexName, documentCount, partitionCount) {
      const entry = indexRegistry.get(indexName)
      if (entry === undefined) return
      entry.documentCount = documentCount
      entry.partitionCount = partitionCount
    },
  })

  invalidation = createInvalidationFromConfig(config, durabilityTier?.kind ?? null, {
    getManager: indexName => executor.getManager(indexName) ?? undefined,
    listBroadcastIndexNames: () => {
      const names: string[] = []
      for (const [name, entry] of indexRegistry) {
        if (entry.config.defaultScoring === 'broadcast') {
          names.push(name)
        }
      }
      return names
    },
    reloadIndex: indexName => durability?.manager.reloadIndex?.(indexName) ?? Promise.resolve(),
    onError(error: Error) {
      const handlers = eventHandlers.get('invalidationError')
      if (!handlers || handlers.size === 0) {
        console.warn('Invalidation error:', error)
        return
      }
      for (const handler of handlers) handler({ error })
    },
  })

  const watermarkNotifier = createWatermarkNotifier({
    getManager: indexName => executor.getManager(indexName),
    getPartitionConfig: indexName => indexRegistry.get(indexName)?.config.partitions,
    emit(payload) {
      const handlers = eventHandlers.get('partitionWatermark')
      if (!handlers) return
      for (const handler of handlers) {
        try {
          handler(payload)
        } catch (err) {
          console.warn('partitionWatermark handler error:', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })

  const analysisRebuild = wireAnalysisRebuild({
    config: config?.analysis,
    eventHandlers,
    getManager: indexName => executor.getManager(indexName),
    desyncIndex: indexName => orchestrator.desyncIndex(indexName),
    resyncIndex: (indexName, wasPromoted) => orchestrator.resyncIndex(indexName, wasPromoted),
    durabilityManager: durability?.manager ?? null,
  })

  const indexState = wireIndexState({
    config: config?.lifecycle,
    durability,
    executor,
    orchestrator,
    analysisRebuild,
    indexRegistry,
    rebalancingIndexes,
    requireManager,
    onClose: hooks?.onIndexClose,
    onOpen: hooks?.onIndexOpen,
    onAccess: indexName => orchestrator.noteAccess(indexName),
  })

  const mutationCtx: MutationContext = {
    executor,
    pluginRegistry,
    durability,
    orchestrator,
    idGenerator,
    abortController,
    guardShutdown,
    requireIndex,
    requireManager,
    bufferIfRebalancing,
    isRebalancing: indexName => rebalancingIndexes.has(indexName),
    pendingRebalanceWrites: indexName => waqMap.get(indexName)?.size ?? 0,
    rebalanceTargetPartitionCount: indexName => rebalanceTargets.get(indexName),
    bufferedDocState: (indexName, docId) => waqMap.get(indexName)?.bufferedDocState(docId),
    checkWatermark: watermarkNotifier.check,
  }

  const rebalanceCtx: RebalanceContext = {
    rebalancer,
    router: rebalanceRouter,
    waqMap,
    rebalancingIndexes,
    rebalanceTargets,
    eventHandlers,
    pluginRegistry,
    orchestrator,
    durabilityManager: durability?.manager ?? null,
    checkWatermark: watermarkNotifier.check,
    requireIndex,
  }

  return {
    executor,
    pluginRegistry,
    durability,
    invalidation,
    idGenerator,
    indexRegistry,
    embeddingAdapters,
    eventHandlers,
    shutdownState,
    abortController,
    orchestrator,
    rebalancer,
    rebalanceRouter,
    rebalancingIndexes,
    waqMap,
    guardShutdown,
    requireIndex,
    requireManager,
    bufferIfRebalancing,
    watermarkNotifier,
    analysisRebuild,
    indexState,
    mutationCtx,
    rebalanceCtx,
  }
}
