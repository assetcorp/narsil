import { generateId } from '../core/id-generator'
import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import { createRebalancer, type Rebalancer } from '../partitioning/rebalancer'
import { createPartitionRouter, type PartitionRouter } from '../partitioning/router'
import type { createWriteAheadQueue, WAQEntry } from '../partitioning/write-ahead-queue'
import { createPluginRegistry, type PluginRegistry } from '../plugins/registry'
import { validateRegisteredAdapter } from '../schema/embedding-validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { VectorWorkerCopyPolicy } from '../vector/vector-index/shared'
import { createDirectExecutor, type DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import { resolveWorkerCount, splitWorkerBudget } from '../workers/worker-count'
import { type AnalysisRebuildCoordinator, wireAnalysisRebuild } from './analysis-rebuild'
import { resolveDurabilityTier } from './durability-config'
import type { DurabilityIntegration } from './durability-integration'
import { createDurabilityFromTier } from './durability-wiring'
import { emitEngineEvent } from './events'
import type { HeapPressureNotifier } from './heap-pressure'
import { createIndexFromMetadata as createIndexFromMetadataOp } from './index-from-metadata'
import type { IndexStateCoordinator } from './index-state'
import { type EngineCoreHooks, wireIndexState } from './index-state-wiring'
import { createInvalidationFromConfig, type InvalidationIntegration } from './invalidation'
import type { MutationContext } from './mutations'
import { type NotifierWiring, wireHeapPressureNotifier, wireWatermarkNotifier } from './notifiers'
import { createWorkerOrchestrator, type WorkerOrchestrator, workersEnabledByDefault } from './orchestration'
import type { RebalanceContext } from './rebalance-executor'
import { validateWorkerConfig } from './validation'
import type { WatermarkNotifier } from './watermark'

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
  /** This reads true where the engine writes checkpoints to a filesystem directory, which a vector field kept on disk needs. */
  readonly filesystemDurability: boolean
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
  readonly heapPressureNotifier: HeapPressureNotifier
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
  const vectorCopyPolicy: VectorWorkerCopyPolicy = {
    enabled: (config?.workers?.enabled ?? workersEnabledByDefault()) && vectorWorkerCount > 0,
    count: vectorWorkerCount,
  }
  const durabilityTier = config !== undefined ? resolveDurabilityTier(config) : null
  if (config?.lifecycle !== undefined && durabilityTier === null) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Index lifecycle settings require durability')
  }
  const filesystemDurability = durabilityTier?.kind === 'wal'
  const executor: Executor & DirectExecutorExtensions = createDirectExecutor({
    vectorWorkerCopies: vectorCopyPolicy,
    vectorStorage: filesystemDurability ? 'disk' : 'memory',
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

  const orchestrator = createWorkerOrchestrator(
    config,
    executor,
    indexRegistry,
    {
      shouldDeferCopies() {
        return rebalancingIndexes.size > 0
      },
      isAnalysisStale(indexName) {
        return analysisRebuild.isStale(indexName)
      },
      onCopiesLoaded(workerCount, reason) {
        emitEngineEvent(eventHandlers, 'workerPromote', { workerCount, reason })
        void Promise.resolve(pluginRegistry.runHook('onWorkerPromote', { workerCount, reason })).catch(
          (err: unknown) => {
            console.warn('onWorkerPromote plugin hook failed:', err instanceof Error ? err.message : String(err))
          },
        )
      },
      onCopyLoadFailure(reason, error, retryable) {
        if (emitEngineEvent(eventHandlers, 'workerPromoteFailure', { reason, error, retryable }) === 0) {
          console.warn(`Loading worker copies failed (${reason}):`, error)
        }
      },
      onWorkerCrash(workerId, indexNames, error) {
        if (emitEngineEvent(eventHandlers, 'workerCrash', { workerId, indexNames, error }) === 0) {
          console.warn(`Worker ${workerId} crashed:`, error)
        }
      },
    },
    vectorCopyPolicy,
  )

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

  function createIndexFromMetadata(metadata: IndexMetadata, loadData: boolean): Promise<void> {
    return createIndexFromMetadataOp(
      {
        config,
        executor,
        indexRegistry,
        embeddingAdapters,
        filesystemDurability,
        indexState: () => indexState,
        analysisRebuild: () => analysisRebuild,
      },
      metadata,
      loadData,
    )
  }

  let invalidation: InvalidationIntegration | null = null

  const durability = createDurabilityFromTier(durabilityTier, {
    getManager: indexName => executor.getManager(indexName),
    indexRegistry,
    createIndexFromMetadata,
    emitFatalError(error: Error) {
      emitEngineEvent(eventHandlers, 'durabilityError', { error })
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
      if (emitEngineEvent(eventHandlers, 'invalidationError', { error }) === 0) {
        console.warn('Invalidation error:', error)
      }
    },
  })

  const notifierWiring: NotifierWiring = {
    eventHandlers,
    indexRegistry,
    getManager: indexName => executor.getManager(indexName),
  }
  const watermarkNotifier = wireWatermarkNotifier(notifierWiring)
  const heapPressureNotifier = wireHeapPressureNotifier(notifierWiring)

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
    onOpen: indexName => {
      heapPressureNotifier.check(indexName)
      return hooks?.onIndexOpen?.(indexName)
    },
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
    awaitRebalanceReplay: indexName => waqMap.get(indexName)?.whenReplayed() ?? Promise.resolve(),
    isRebalancing: indexName => rebalancingIndexes.has(indexName),
    pendingRebalanceWrites: indexName => waqMap.get(indexName)?.size ?? 0,
    rebalanceTargetPartitionCount: indexName => rebalanceTargets.get(indexName),
    bufferedDocState: (indexName, docId) => waqMap.get(indexName)?.bufferedDocState(docId),
    checkWatermark: watermarkNotifier.check,
    checkHeapPressure: heapPressureNotifier.check,
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
    filesystemDurability,
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
    heapPressureNotifier,
    analysisRebuild,
    indexState,
    mutationCtx,
    rebalanceCtx,
  }
}
