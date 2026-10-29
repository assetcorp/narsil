import { fnv1a } from '../core/hash'
import type { ReplicationOperation } from '../distribution/replication/types'
import { createDurabilityManager, type DurabilityManager } from '../persistence/durability'
import { createSnapshotOnlyManager } from '../persistence/durability/snapshot-only'
import type { CheckpointPublisher, IndexDurabilityHooks, MutationRecord } from '../persistence/durability/types'
import { encodeDocument } from '../serialization/document-encoding'
import type { PersistenceAdapter } from '../types/adapters'
import type { DurabilityConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { AnyDocument } from '../types/schema'
import { type MetadataConfig, metadataFromConfig } from './durability-metadata'

export type DurabilityTier =
  | { kind: 'wal'; config: DurabilityConfig }
  | { kind: 'snapshot'; config: DurabilityConfig; adapter: PersistenceAdapter }

export interface DurableWrite {
  indexName: string
  partitionId: number
  seqNo: number
}

export type ApplyMutation = () => void | Promise<void>

export interface DurableMutation {
  docId: string
  document: AnyDocument | null
  apply: ApplyMutation
}

export type DurableWriteOutcome = { ok: true; write: DurableWrite } | { ok: false; error: unknown }

export interface DurabilityIntegration {
  manager: DurabilityManager
  recordInsertOrUpdate(
    indexName: string,
    docId: string,
    document: AnyDocument,
    apply: ApplyMutation,
  ): Promise<DurableWrite>
  recordMutationBatch(indexName: string, mutations: readonly DurableMutation[]): Promise<DurableWriteOutcome[]>
  recordRemove(indexName: string, docId: string, apply: ApplyMutation): Promise<DurableWrite>
}

export interface DurabilityIntegrationHooks {
  getManager: IndexDurabilityHooks['getManager']
  getVectorFieldPaths: IndexDurabilityHooks['getVectorFieldPaths']
  getVectorIndexes: IndexDurabilityHooks['getVectorIndexes']
  getIndexConfig: (indexName: string) => MetadataConfig | undefined
  createIndexFromMetadata: IndexDurabilityHooks['createIndexFromMetadata']
  recordCheckpoint: IndexDurabilityHooks['recordCheckpoint']
  onLayoutUpgrade?: IndexDurabilityHooks['onLayoutUpgrade']
  onCheckpointHeld?: IndexDurabilityHooks['onCheckpointHeld']
  onFatalError: IndexDurabilityHooks['onFatalError']
  checkpointPublisher?: CheckpointPublisher
}

function buildMetadata(
  indexName: string,
  hooks: DurabilityIntegrationHooks,
  documentCount?: number,
): IndexMetadata | undefined {
  const config = hooks.getIndexConfig(indexName)
  if (config === undefined) {
    return undefined
  }
  return metadataFromConfig(indexName, config, hooks.getManager(indexName)?.partitionCount, documentCount)
}

export function createDurabilityIntegration(
  tier: DurabilityTier,
  hooks: DurabilityIntegrationHooks,
): DurabilityIntegration {
  const managerHooks: IndexDurabilityHooks = {
    getManager: hooks.getManager,
    getVectorFieldPaths: hooks.getVectorFieldPaths,
    getVectorIndexes: hooks.getVectorIndexes,
    buildMetadata: (indexName, documentCount) => buildMetadata(indexName, hooks, documentCount),
    createIndexFromMetadata: hooks.createIndexFromMetadata,
    recordCheckpoint: hooks.recordCheckpoint,
    onLayoutUpgrade: hooks.onLayoutUpgrade,
    onCheckpointHeld: hooks.onCheckpointHeld,
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
      return recordMutation(indexName, docId, 'INDEX', encodeDocument(document), apply)
    },
    async recordMutationBatch(
      indexName: string,
      mutations: readonly DurableMutation[],
    ): Promise<DurableWriteOutcome[]> {
      const records: MutationRecord[] = []
      const outcomes: DurableWriteOutcome[] = new Array(mutations.length)
      const recordPositions: number[] = []
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i]
        try {
          records.push({
            indexName,
            partitionId: partitionFor(indexName, mutation.docId),
            operation: mutation.document === null ? 'DELETE' : 'INDEX',
            documentId: mutation.docId,
            document: mutation.document === null ? null : encodeDocument(mutation.document),
            apply: mutation.apply,
          })
          recordPositions.push(i)
        } catch (error) {
          outcomes[i] = { ok: false, error }
        }
      }
      const recorded = await manager.recordMutations(records)
      for (let i = 0; i < recorded.length; i++) {
        const outcome = recorded[i]
        outcomes[recordPositions[i]] = outcome.ok
          ? { ok: true, write: { indexName, partitionId: records[i].partitionId, seqNo: outcome.seqNo } }
          : outcome
      }
      return outcomes
    },
    recordRemove(indexName: string, docId: string, apply: ApplyMutation): Promise<DurableWrite> {
      return recordMutation(indexName, docId, 'DELETE', null, apply)
    },
  }
}
