import { generateId } from '../core/id-generator'
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
import { createDurabilityIntegration, type DurabilityIntegration, type DurabilityTier } from './durability-integration'
import type { MutationContext } from './mutations'
import { createWorkerOrchestrator, type WorkerOrchestrator } from './orchestration'
import type { RebalanceContext } from './rebalance-executor'
import { reconstructSchemaFromMetadata } from './recovery-schema'

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
  readonly lastAppliedSeqMap: Map<string, Map<number, number>>
  readonly guardShutdown: () => void
  readonly requireIndex: (indexName: string) => IndexRegistryEntry
  readonly requireManager: (indexName: string) => PartitionManager
  readonly bufferIfRebalancing: (indexName: string, entry: Omit<WAQEntry, 'sequenceNumber'>) => boolean
  readonly mutationCtx: MutationContext
  readonly rebalanceCtx: RebalanceContext
}

export function getVectorFieldPaths(schema: SchemaDefinition): Set<string> {
  return new Set(extractVectorFieldsFromSchema(schema).keys())
}

function filesystemBackedDirectory(config: NarsilConfig): string | null {
  const adapterDirectory = config.persistence?.directory
  if (adapterDirectory !== undefined && adapterDirectory.trim().length > 0) {
    return adapterDirectory
  }
  return null
}

function resolveDurabilityTier(config: NarsilConfig): DurabilityTier | null {
  const filesystemDirectory = filesystemBackedDirectory(config)

  if (config.durability) {
    if (config.durability.directory !== undefined && config.durability.directory.trim().length > 0) {
      return { kind: 'wal', config: { ...config.durability } }
    }
    if (filesystemDirectory !== null) {
      return { kind: 'wal', config: { ...config.durability, directory: filesystemDirectory } }
    }
    if (config.persistence !== undefined) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'WAL durability requires a filesystem directory, but the configured persistence adapter is not filesystem-backed. Use a filesystem persistence adapter or set durability.directory',
      )
    }
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Durability requires a directory. Set durability.directory explicitly, or configure a filesystem persistence adapter',
    )
  }

  if (config.persistence === undefined) {
    return null
  }
  if (filesystemDirectory !== null) {
    return { kind: 'wal', config: { directory: filesystemDirectory } }
  }
  return { kind: 'snapshot', config: {}, adapter: config.persistence }
}

interface DurabilityWiring {
  requireManager: (indexName: string) => PartitionManager
  indexRegistry: Map<string, IndexRegistryEntry>
  createIndexFromMetadata: (metadata: IndexMetadata) => Promise<void>
  emitFatalError: (error: Error) => void
}

function createDurabilityFromConfig(
  config: NarsilConfig | undefined,
  wiring: DurabilityWiring,
): DurabilityIntegration | null {
  if (config === undefined) {
    return null
  }
  const tier = resolveDurabilityTier(config)
  if (tier === null) {
    return null
  }

  return createDurabilityIntegration(tier, {
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

  const orchestrator = createWorkerOrchestrator(config, executor, promoter, indexRegistry, {
    onPromotion(workerCount, reason) {
      const handlers = eventHandlers.get('workerPromote')
      if (handlers) {
        for (const handler of handlers) handler({ workerCount, reason })
      }
    },
  })

  const rebalancer = createRebalancer()
  const rebalanceRouter = createPartitionRouter()
  const rebalancingIndexes = new Set<string>()
  const waqMap = new Map<string, ReturnType<typeof createWriteAheadQueue>>()
  const lastAppliedSeqMap = new Map<string, Map<number, number>>()

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

    executor.createIndex(metadata.indexName, indexConfig, language)
    indexRegistry.set(metadata.indexName, {
      config: indexConfig,
      language,
      embeddingAdapter,
      embeddingAdapterName: adapterName,
      vectorFieldPaths: getVectorFieldPaths(indexConfig.schema),
    })
  }

  const durability = createDurabilityFromConfig(config, {
    requireManager,
    indexRegistry,
    createIndexFromMetadata,
    emitFatalError(error: Error) {
      const handlers = eventHandlers.get('durabilityError')
      if (handlers) {
        for (const handler of handlers) handler({ error })
      }
    },
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
  }

  const rebalanceCtx: RebalanceContext = {
    rebalancer,
    router: rebalanceRouter,
    waqMap,
    rebalancingIndexes,
    lastAppliedSeqMap,
    eventHandlers,
    requireIndex,
  }

  return {
    executor,
    promoter,
    pluginRegistry,
    durability,
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
    lastAppliedSeqMap,
    guardShutdown,
    requireIndex,
    requireManager,
    bufferIfRebalancing,
    mutationCtx,
    rebalanceCtx,
  }
}
