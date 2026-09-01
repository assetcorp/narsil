import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import type { IndexLifecycleConfig } from '../types/config'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import type { AnalysisRebuildCoordinator } from './analysis-rebuild'
import type { IndexRegistryEntry } from './core'
import type { DurabilityIntegration } from './durability-integration'
import { createIndexStateCoordinator, type IndexStateCoordinator } from './index-state'
import type { WorkerOrchestrator } from './orchestration'

export interface EngineCoreHooks {
  onIndexOpen?(indexName: string): void | Promise<void>
  onIndexClose?(indexName: string): void | Promise<void>
}

interface IndexStateWiring {
  config: IndexLifecycleConfig | undefined
  durability: DurabilityIntegration | null
  executor: Executor & DirectExecutorExtensions
  orchestrator: WorkerOrchestrator
  analysisRebuild: AnalysisRebuildCoordinator
  indexRegistry: Map<string, IndexRegistryEntry>
  rebalancingIndexes: Set<string>
  requireManager(indexName: string): PartitionManager
  onOpen?(indexName: string): void | Promise<void>
  onClose?(indexName: string): void | Promise<void>
}

/**
 * Connects the index state machine to durability, workers, and engine memory.
 *
 * @param wiring - Engine services needed to open and close one index.
 * @returns The connected state coordinator.
 */
export function wireIndexState(wiring: IndexStateWiring): IndexStateCoordinator {
  const { durability, executor, orchestrator, analysisRebuild, indexRegistry, rebalancingIndexes } = wiring
  return createIndexStateCoordinator(wiring.config, {
    async reopen(indexName: string): Promise<void> {
      if (durability === null) {
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'An index needs durability before it can reopen')
      }
      try {
        await durability.manager.recoverIndex(indexName)
        await analysisRebuild.review(indexName)
        await orchestrator.openIndex(indexName)
        await wiring.onOpen?.(indexName)
      } catch (error) {
        await orchestrator.closeIndex(indexName).catch(() => undefined)
        await durability.manager.unloadIndex(indexName).catch(() => undefined)
        if (executor.getManager(indexName) !== undefined) executor.dropIndex(indexName)
        throw error
      }
    },
    async close(indexName: string): Promise<void> {
      if (durability === null) {
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'An index needs durability before it can close')
      }
      const manager = wiring.requireManager(indexName)
      const documentCount = manager.countDocuments()
      const partitionCount = manager.partitionCount
      await (durability.manager.checkpointFromMemory?.(indexName) ?? durability.manager.checkpoint(indexName))
      await orchestrator.closeIndex(indexName)
      await durability.manager.unloadIndex(indexName)
      await wiring.onClose?.(indexName)
      executor.dropIndex(indexName)
      const entry = indexRegistry.get(indexName)
      if (entry !== undefined) {
        entry.documentCount = documentCount
        entry.partitionCount = partitionCount
      }
    },
    canCloseAutomatically(indexName: string): boolean {
      return (
        !rebalancingIndexes.has(indexName) &&
        !analysisRebuild.isRunning(indexName) &&
        !orchestrator.isIndexBusy(indexName)
      )
    },
    estimateBytes(indexName: string): number {
      return executor.getManager(indexName)?.estimateMemoryBytes() ?? 0
    },
  })
}
