import type { PartitionManager } from '../partitioning/manager'
import type { LayoutUpgradeEvent } from '../persistence/durability/earlier-layout/upgrade'
import type { IndexDurabilityHooks } from '../persistence/durability/types'
import type { IndexMetadata } from '../types/internal'
import type { HeldCheckpointReport } from '../types/memory'
import type { EngineCore, IndexRegistryEntry } from './core'
import { createDurabilityIntegration, type DurabilityIntegration, type DurabilityTier } from './durability-integration'
import { durableMetadataConfigOf, metadataConfigOf } from './durability-metadata'
import type { WorkerOrchestrator } from './orchestration'
import { scheduleSyncRetention } from './sync/retention'

export { createInvalidationFromConfig } from './invalidation'

interface DurabilityWiring {
  getManager: (indexName: string) => PartitionManager | undefined
  indexRegistry: Map<string, IndexRegistryEntry>
  createIndexFromMetadata: (metadata: IndexMetadata, loadData: boolean) => Promise<void>
  emitFatalError: (error: Error) => void
  emitLayoutUpgrade: (event: LayoutUpgradeEvent) => void
  emitCheckpointHeld: (report: HeldCheckpointReport) => void
  publishCheckpointedPartitions: (indexName: string, partitions: number[]) => Promise<void>
  engineCore: () => EngineCore
  queueDiskAdoption?: IndexDurabilityHooks['queueDiskAdoption']
  awaitCopiesOfIndex?: IndexDurabilityHooks['awaitCopiesOfIndex']
}

export function createDurabilityFromTier(tier: DurabilityTier, wiring: DurabilityWiring): DurabilityIntegration {
  return createDurabilityIntegration(tier, {
    checkpointPublisher: { publishPartitions: wiring.publishCheckpointedPartitions },
    getManager: indexName => (wiring.indexRegistry.has(indexName) ? wiring.getManager(indexName) : undefined),
    getVectorFieldPaths: indexName => wiring.indexRegistry.get(indexName)?.vectorFieldPaths ?? new Set<string>(),
    getVectorIndexes: indexName =>
      (wiring.indexRegistry.has(indexName) ? wiring.getManager(indexName)?.getVectorIndexes() : undefined) ?? new Map(),
    getIndexConfig: indexName => {
      const entry = wiring.indexRegistry.get(indexName)
      return entry === undefined ? undefined : durableMetadataConfigOf(entry)
    },
    getTermsConfig: indexName => {
      const entry = wiring.indexRegistry.get(indexName)
      return entry === undefined ? undefined : metadataConfigOf(entry)
    },
    mustRewriteTerms: indexName => (wiring.indexRegistry.get(indexName)?.durableAnalysis ?? null) !== null,
    onManifestCommitted(indexName, analysisGeneration) {
      const entry = wiring.indexRegistry.get(indexName)
      if (entry !== undefined && entry.analysisGeneration === analysisGeneration) entry.durableAnalysis = null
    },
    queueDiskAdoption: wiring.queueDiskAdoption,
    awaitCopiesOfIndex: wiring.awaitCopiesOfIndex,
    createIndexFromMetadata: wiring.createIndexFromMetadata,
    recordCheckpoint(indexName, documentCount, partitionCount, savedBytes) {
      const entry = wiring.indexRegistry.get(indexName)
      if (entry === undefined) return
      entry.documentCount = documentCount
      entry.partitionCount = partitionCount
      entry.savedBytes = savedBytes
    },
    onLayoutUpgrade: wiring.emitLayoutUpgrade,
    onCheckpointHeld: wiring.emitCheckpointHeld,
    onFatalError: wiring.emitFatalError,
    keepsSyncHistory: indexName => wiring.indexRegistry.get(indexName)?.sync?.active === true,
    onHistoryMoved(indexName) {
      if (wiring.indexRegistry.get(indexName)?.sync?.active !== true) return
      try {
        scheduleSyncRetention(wiring.engineCore(), indexName)
      } catch (error) {
        wiring.emitFatalError(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })
}

export async function reloadIndexAndCopies(
  orchestrator: WorkerOrchestrator,
  durability: DurabilityIntegration | null,
  indexName: string,
): Promise<void> {
  const manager = durability?.manager
  if (manager?.reloadIndex === undefined) return
  const wasScaledOut = orchestrator.desyncIndex(indexName)
  try {
    await manager.reloadIndex(indexName)
  } finally {
    await orchestrator.resyncIndex(indexName, wasScaledOut)
  }
}
