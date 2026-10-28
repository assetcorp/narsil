import type { PartitionManager } from '../partitioning/manager'
import type { LayoutUpgradeEvent } from '../persistence/durability/earlier-layout/upgrade'
import type { IndexMetadata } from '../types/internal'
import type { IndexRegistryEntry } from './core'
import { createDurabilityIntegration, type DurabilityIntegration, type DurabilityTier } from './durability-integration'
import { metadataConfigOf } from './durability-metadata'

interface DurabilityWiring {
  getManager: (indexName: string) => PartitionManager | undefined
  indexRegistry: Map<string, IndexRegistryEntry>
  createIndexFromMetadata: (metadata: IndexMetadata, loadData: boolean) => Promise<void>
  emitFatalError: (error: Error) => void
  emitLayoutUpgrade: (event: LayoutUpgradeEvent) => void
  publishCheckpointedPartitions: (indexName: string, partitions: number[]) => Promise<void>
  recordCheckpoint: (indexName: string, documentCount: number, partitionCount: number) => void
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
      return entry === undefined ? undefined : metadataConfigOf(entry)
    },
    createIndexFromMetadata: wiring.createIndexFromMetadata,
    recordCheckpoint: wiring.recordCheckpoint,
    onLayoutUpgrade: wiring.emitLayoutUpgrade,
    onFatalError: wiring.emitFatalError,
  })
}
