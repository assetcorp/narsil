import { generateId } from '../core/id-generator'
import { compareCodePoints } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import type { PartitionManager } from '../partitioning/manager'
import { createRebalancer, type Rebalancer } from '../partitioning/rebalancer'
import { createPartitionRouter, type PartitionRouter } from '../partitioning/router'
import type { createWriteAheadQueue, WAQEntry } from '../partitioning/write-ahead-queue'
import { createPluginRegistry, type PluginRegistry } from '../plugins/registry'
import { validateEmbeddingConfig, validateRegisteredAdapter } from '../schema/embedding-validator'
import { extractVectorFieldsFromSchema, flattenSchema } from '../schema/validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { IndexConfig, SchemaDefinition } from '../types/schema'
import { createDirectExecutor, type DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import { createExecutionPromoter, type ExecutionPromoter } from '../workers/promoter'
import { type AnalysisRebuildCoordinator, wireAnalysisRebuild } from './analysis-rebuild'
import { resolveDurabilityTier } from './durability-config'
import { createDurabilityIntegration, type DurabilityIntegration, type DurabilityTier } from './durability-integration'
import { createInvalidationFromConfig, type InvalidationIntegration } from './invalidation'
import type { MutationContext } from './mutations'
import { createWorkerOrchestrator, type WorkerOrchestrator } from './orchestration'
import type { RebalanceContext } from './rebalance-executor'
import { reconstructSchemaFromMetadata } from './recovery-schema'
import { createWatermarkNotifier, type WatermarkNotifier } from './watermark'

export type IndexRegistryEntry = {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
  /** Registry name the adapter was resolved from; lets durability metadata
   * persist the binding and lets late registration rebind recovered indexes. */
  embeddingAdapterName: string | null
  vectorFieldPaths: Set<string>
}

export type EventHandler = (payload: unknown) => void

export interface ShutdownState {
  isShutdown: boolean
}

export interface EngineCore {
  readonly executor: Executor & DirectExecutorExtensions
  readonly promoter: ExecutionPromoter
  readonly pluginRegistry: PluginRegistry
  readonly durability: DurabilityIntegration | null
  readonly invalidation: InvalidationIntegration | null
  readonly idGenerator: () => string
  readonly indexRegistry: Map<string, IndexRegistryEntry>
  readonly embeddingAdapters: Map<string, EmbeddingAdapter>
  readonly eventHandlers: Map<string, Set<EventHandler>>
  readonly shutdownState: ShutdownState
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
  readonly mutationCtx: MutationContext
  readonly rebalanceCtx: RebalanceContext
}

export function getVectorFieldPaths(schema: SchemaDefinition): Set<string> {
  return new Set(extractVectorFieldsFromSchema(schema).keys())
}

interface DurabilityWiring {
  requireManager: (indexName: string) => PartitionManager
  indexRegistry: Map<string, IndexRegistryEntry>
  createIndexFromMetadata: (metadata: IndexMetadata) => Promise<void>
  emitFatalError: (error: Error) => void
  publishCheckpointedPartitions: (indexName: string, partitions: number[]) => Promise<void>
}

function createDurabilityFromTier(tier: DurabilityTier | null, wiring: DurabilityWiring): DurabilityIntegration | null {
  if (tier === null) {
    return null
  }

  return createDurabilityIntegration(tier, {
    checkpointPublisher: { publishPartitions: wiring.publishCheckpointedPartitions },
    getManager: indexName => (wiring.indexRegistry.has(indexName) ? wiring.requireManager(indexName) : undefined),
    getVectorFieldPaths: indexName => wiring.indexRegistry.get(indexName)?.vectorFieldPaths ?? new Set<string>(),
    getVectorIndexes: indexName =>
      wiring.indexRegistry.has(indexName) ? wiring.requireManager(indexName).getVectorIndexes() : new Map(),
    getIndexConfig: indexName => {
      const entry = wiring.indexRegistry.get(indexName)
      if (entry === undefined) {
        return undefined
      }
      const embedding = entry.config.embedding
        ? {
            fields: entry.config.embedding.fields,
            ...(entry.embeddingAdapterName !== null ? { adapter: entry.embeddingAdapterName } : {}),
          }
        : undefined
      return {
        schema: flattenSchema(entry.config.schema) as Record<string, string>,
        language: entry.language.name,
        k1: entry.config.bm25?.k1 ?? 1.2,
        b: entry.config.bm25?.b ?? 0.75,
        ...(embedding !== undefined ? { embedding } : {}),
        surfaceForms: entry.config.surfaceForms !== false,
        analysisRevision: entry.language.revision,
        ...(typeof entry.config.tokenizer === 'string' ? { tokenizer: entry.config.tokenizer } : {}),
        ...(typeof entry.config.stopWords === 'string' ? { stopWords: entry.config.stopWords } : {}),
        ...(entry.config.stopWords instanceof Set
          ? { stopWordList: [...entry.config.stopWords].sort(compareCodePoints) }
          : {}),
        ...(entry.config.partitions !== undefined ? { partitionLimits: entry.config.partitions } : {}),
        ...(entry.config.defaultScoring !== undefined ? { defaultScoring: entry.config.defaultScoring } : {}),
        ...(entry.config.trackPositions !== undefined ? { trackPositions: entry.config.trackPositions } : {}),
        ...(entry.config.strict !== undefined ? { strict: entry.config.strict } : {}),
        ...(entry.config.required !== undefined ? { required: entry.config.required } : {}),
        ...(entry.config.vectorPromotion !== undefined ? { vectorPromotion: entry.config.vectorPromotion } : {}),
      }
    },
    createIndexFromMetadata: wiring.createIndexFromMetadata,
    onFatalError: wiring.emitFatalError,
  })
}

export function createEngineCore(config?: NarsilConfig): EngineCore {
  const executor: Executor & DirectExecutorExtensions = createDirectExecutor()
  const promoter = createExecutionPromoter({
    perIndexThreshold: config?.workers?.promotionThreshold,
    totalThreshold: config?.workers?.totalPromotionThreshold,
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
  const shutdownState: ShutdownState = { isShutdown: false }
  const abortController = new AbortController()
  const rebalancingIndexes = new Set<string>()

  const orchestrator = createWorkerOrchestrator(config, executor, promoter, indexRegistry, {
    shouldDeferPromotion() {
      return rebalancingIndexes.size > 0
    },
    onPromotion(workerCount, reason) {
      const handlers = eventHandlers.get('workerPromote')
      if (handlers) {
        for (const handler of handlers) handler({ workerCount, reason })
      }
    },
    onPromotionFailure(reason, error, retryable) {
      const handlers = eventHandlers.get('workerPromoteFailure')
      if (!handlers || handlers.size === 0) {
        console.warn(`Worker promotion failed (${reason}):`, error)
        return
      }
      for (const handler of handlers) handler({ reason, error, retryable })
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

  async function createIndexFromMetadata(metadata: IndexMetadata): Promise<void> {
    if (indexRegistry.has(metadata.indexName)) {
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
        // A dimension change between runs can never work against the stored
        // vectors, so recovery fails loudly instead of binding a broken pair.
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
      executor.createIndex(metadata.indexName, indexConfig, language)
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
    })
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
  let invalidation: InvalidationIntegration | null = null

  const durability = createDurabilityFromTier(durabilityTier, {
    requireManager,
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
    promoter,
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
    mutationCtx,
    rebalanceCtx,
  }
}
