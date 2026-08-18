import { compareCodePoints } from '../core/ordering'
import type { PartitionManager } from '../partitioning/manager'
import { flattenSchema } from '../schema/validator'
import type { IndexMetadata } from '../types/internal'
import type { IndexRegistryEntry } from './core'
import { createDurabilityIntegration, type DurabilityIntegration, type DurabilityTier } from './durability-integration'

interface DurabilityWiring {
  requireManager: (indexName: string) => PartitionManager
  indexRegistry: Map<string, IndexRegistryEntry>
  createIndexFromMetadata: (metadata: IndexMetadata) => Promise<void>
  emitFatalError: (error: Error) => void
  publishCheckpointedPartitions: (indexName: string, partitions: number[]) => Promise<void>
}

/**
 * Builds the durability integration one tier calls for, or null where the
 * engine keeps nothing on disk.
 *
 * @param tier - The resolved durability tier, or null for an engine that
 * persists nothing.
 * @param wiring - The engine pieces the integration reads and drives.
 * @returns The integration, or null where the tier is absent.
 */
export function createDurabilityFromTier(
  tier: DurabilityTier | null,
  wiring: DurabilityWiring,
): DurabilityIntegration | null {
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
        ...(entry.indexUuid !== null ? { indexUuid: entry.indexUuid } : {}),
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
