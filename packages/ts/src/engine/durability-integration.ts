import { encode } from '@msgpack/msgpack'
import { fnv1a } from '../core/hash'
import type { ReplicationOperation } from '../distribution/replication/types'
import { VERSION } from '../index'
import { createDurabilityManager, type DurabilityManager } from '../persistence/durability'
import { createSnapshotOnlyManager } from '../persistence/durability/snapshot-only'
import type { CheckpointPublisher, IndexDurabilityHooks } from '../persistence/durability/types'
import type { PersistenceAdapter } from '../types/adapters'
import type { DurabilityConfig } from '../types/config'
import type { IndexEmbeddingMetadata, IndexMetadata } from '../types/internal'
import type { AnyDocument, PartitionConfig, ScoringMode, VectorIndexConfig } from '../types/schema'

export type DurabilityTier =
  | { kind: 'wal'; config: DurabilityConfig }
  | { kind: 'snapshot'; config: DurabilityConfig; adapter: PersistenceAdapter }

export interface DurableWrite {
  indexName: string
  partitionId: number
  seqNo: number
}

export type ApplyMutation = () => void | Promise<void>

export interface DurabilityIntegration {
  manager: DurabilityManager
  recordInsertOrUpdate(
    indexName: string,
    docId: string,
    document: AnyDocument,
    apply: ApplyMutation,
  ): Promise<DurableWrite>
  recordRemove(indexName: string, docId: string, apply: ApplyMutation): Promise<DurableWrite>
}

export interface DurabilityIntegrationHooks {
  getManager: IndexDurabilityHooks['getManager']
  getVectorFieldPaths: IndexDurabilityHooks['getVectorFieldPaths']
  getVectorIndexes: IndexDurabilityHooks['getVectorIndexes']
  getIndexConfig: (indexName: string) =>
    | {
        schema: Record<string, string>
        language: string
        k1: number
        b: number
        embedding?: IndexEmbeddingMetadata
        surfaceForms?: boolean
        analysisRevision?: string
        tokenizer?: string
        stopWords?: string
        stopWordList?: string[]
        partitionLimits?: PartitionConfig
        defaultScoring?: ScoringMode
        trackPositions?: boolean
        strict?: boolean
        required?: string[]
        vectorPromotion?: VectorIndexConfig
      }
    | undefined
  createIndexFromMetadata: IndexDurabilityHooks['createIndexFromMetadata']
  onFatalError: IndexDurabilityHooks['onFatalError']
  checkpointPublisher?: CheckpointPublisher
}

function buildMetadata(indexName: string, hooks: DurabilityIntegrationHooks): IndexMetadata | undefined {
  const config = hooks.getIndexConfig(indexName)
  const manager = hooks.getManager(indexName)
  if (config === undefined || manager === undefined) {
    return undefined
  }
  const metadata: IndexMetadata = {
    indexName,
    schema: config.schema,
    language: config.language,
    partitionCount: manager.partitionCount,
    bm25Params: { k1: config.k1, b: config.b },
    createdAt: Date.now(),
    engineVersion: VERSION,
  }
  if (config.embedding) {
    metadata.embedding = config.embedding
  }
  if (config.surfaceForms !== undefined) {
    metadata.surfaceForms = config.surfaceForms
  }
  if (config.analysisRevision !== undefined) {
    metadata.analysisRevision = config.analysisRevision
  }
  if (config.tokenizer !== undefined) {
    metadata.tokenizer = config.tokenizer
  }
  if (config.stopWords !== undefined) {
    metadata.stopWords = config.stopWords
  }
  if (config.stopWordList !== undefined) {
    metadata.stopWordList = config.stopWordList
  }
  if (config.partitionLimits !== undefined) {
    metadata.partitionLimits = config.partitionLimits
  }
  if (config.defaultScoring !== undefined) {
    metadata.defaultScoring = config.defaultScoring
  }
  if (config.trackPositions !== undefined) {
    metadata.trackPositions = config.trackPositions
  }
  if (config.strict !== undefined) {
    metadata.strict = config.strict
  }
  if (config.required !== undefined) {
    metadata.required = config.required
  }
  if (config.vectorPromotion !== undefined) {
    metadata.vectorPromotion = config.vectorPromotion
  }
  return metadata
}

export function createDurabilityIntegration(
  tier: DurabilityTier,
  hooks: DurabilityIntegrationHooks,
): DurabilityIntegration {
  const managerHooks: IndexDurabilityHooks = {
    getManager: hooks.getManager,
    getVectorFieldPaths: hooks.getVectorFieldPaths,
    getVectorIndexes: hooks.getVectorIndexes,
    buildMetadata: indexName => buildMetadata(indexName, hooks),
    createIndexFromMetadata: hooks.createIndexFromMetadata,
    onFatalError: hooks.onFatalError,
  }

  const manager =
    tier.kind === 'wal'
      ? createDurabilityManager(tier.config, managerHooks)
      : createSnapshotOnlyManager(tier.adapter, tier.config, managerHooks, hooks.checkpointPublisher)

  function partitionFor(indexName: string, docId: string): number {
    const partitionManager = hooks.getManager(indexName)
    const partitionCount = partitionManager?.partitionCount ?? 1
    return fnv1a(docId) % Math.max(1, partitionCount)
  }

  async function recordMutation(
    indexName: string,
    docId: string,
    operation: ReplicationOperation,
    document: Uint8Array | null,
    apply: ApplyMutation,
  ): Promise<DurableWrite> {
    const partitionId = partitionFor(indexName, docId)
    const seqNo = await manager.recordMutation({
      indexName,
      partitionId,
      operation,
      documentId: docId,
      document,
      apply,
    })
    return { indexName, partitionId, seqNo }
  }

  return {
    manager,
    recordInsertOrUpdate(
      indexName: string,
      docId: string,
      document: AnyDocument,
      apply: ApplyMutation,
    ): Promise<DurableWrite> {
      return recordMutation(indexName, docId, 'INDEX', encode(document), apply)
    },
    recordRemove(indexName: string, docId: string, apply: ApplyMutation): Promise<DurableWrite> {
      return recordMutation(indexName, docId, 'DELETE', null, apply)
    },
  }
}
