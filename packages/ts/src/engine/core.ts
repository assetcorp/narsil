import { generateId } from '../core/id-generator'
import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import { createRebalancer, type Rebalancer } from '../partitioning/rebalancer'
import { createPartitionRouter, type PartitionRouter } from '../partitioning/router'
import type { createWriteAheadQueue, WAQEntry } from '../partitioning/write-ahead-queue'
import { createFlushManager, type FlushManager } from '../persistence/flush-manager'
import { createPluginRegistry, type PluginRegistry } from '../plugins/registry'
import { extractVectorFieldsFromSchema } from '../schema/validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { LanguageModule } from '../types/language'
import type { IndexConfig, SchemaDefinition } from '../types/schema'
import { createDirectExecutor, type DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import { createExecutionPromoter, type ExecutionPromoter } from '../workers/promoter'
import type { MutationContext } from './mutations'
import { createWorkerOrchestrator, type WorkerOrchestrator } from './orchestration'
import type { RebalanceContext } from './rebalance-executor'

export type IndexRegistryEntry = {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
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
  readonly flushManager: FlushManager | null
  readonly idGenerator: () => string
  readonly indexRegistry: Map<string, IndexRegistryEntry>
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
  const indexRegistry = new Map<string, IndexRegistryEntry>()
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

  const mutationCtx: MutationContext = {
    executor,
    pluginRegistry,
    flushManager,
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
    flushManager,
    idGenerator,
    indexRegistry,
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
