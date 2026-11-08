import { turnIsSpent, turnsAreBudgeted, yieldTurn } from '#platform/turn-budget'
import { fnv1a } from '../core/hash'
import type { ReplicationOperation } from '../distribution/replication/types'
import { metadataPartitionCount } from '../partitioning/manager/checkpoint-prefix'
import { admitDurableWrite } from '../partitioning/wal-routing'
import type { QueuedWrite } from '../partitioning/write-ahead-queue'
import { createDurabilityManager, type DurabilityManager } from '../persistence/durability'
import { deferMutationPublication } from '../persistence/durability/deferred-mutations'
import { createSnapshotOnlyManager } from '../persistence/durability/snapshot-only'
import type {
  CheckpointPublisher,
  IndexDurabilityHooks,
  MutationOutcome,
  MutationRecord,
} from '../persistence/durability/types'
import { encodeDocument } from '../serialization/document-encoding'
import type { PersistenceAdapter } from '../types/adapters'
import type { DurabilityConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { AnyDocument } from '../types/schema'
import { type MetadataConfig, metadataFromConfig } from './durability-metadata'
import type { ApplyMutation } from './mutations/context'

export type { ApplyMutation } from './mutations/context'

export type DurabilityTier =
  | { kind: 'wal'; config: DurabilityConfig }
  | { kind: 'snapshot'; config: DurabilityConfig; adapter: PersistenceAdapter }

export interface DurableWrite {
  indexName: string
  partitionId: number
  seqNo: number
}

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
  getTermsConfig: (indexName: string) => MetadataConfig | undefined
  mustRewriteTerms: IndexDurabilityHooks['mustRewriteTerms']
  onManifestCommitted: IndexDurabilityHooks['onManifestCommitted']
  queueDiskAdoption?: IndexDurabilityHooks['queueDiskAdoption']
  awaitCopiesOfIndex?: IndexDurabilityHooks['awaitCopiesOfIndex']
  createIndexFromMetadata: IndexDurabilityHooks['createIndexFromMetadata']
  recordCheckpoint: IndexDurabilityHooks['recordCheckpoint']
  onLayoutUpgrade?: IndexDurabilityHooks['onLayoutUpgrade']
  onCheckpointHeld?: IndexDurabilityHooks['onCheckpointHeld']
  onFatalError: IndexDurabilityHooks['onFatalError']
  keepsSyncHistory?: IndexDurabilityHooks['keepsSyncHistory']
  onHistoryMoved?: IndexDurabilityHooks['onHistoryMoved']
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
  const manager = hooks.getManager(indexName)
  return metadataFromConfig(
    indexName,
    config,
    manager === undefined ? undefined : metadataPartitionCount(manager),
    documentCount,
  )
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
    buildTermsMetadata(indexName) {
      const config = hooks.getTermsConfig(indexName)
      return config === undefined
        ? undefined
        : metadataFromConfig(indexName, config, hooks.getManager(indexName)?.partitionCount)
    },
    mustRewriteTerms: hooks.mustRewriteTerms,
    onManifestCommitted: hooks.onManifestCommitted,
    ...(hooks.queueDiskAdoption === undefined ? {} : { queueDiskAdoption: hooks.queueDiskAdoption }),
    ...(hooks.awaitCopiesOfIndex === undefined ? {} : { awaitCopiesOfIndex: hooks.awaitCopiesOfIndex }),
    createIndexFromMetadata: hooks.createIndexFromMetadata,
    recordCheckpoint: hooks.recordCheckpoint,
    onLayoutUpgrade: hooks.onLayoutUpgrade,
    onCheckpointHeld: hooks.onCheckpointHeld,
    onFatalError: hooks.onFatalError,
    ...(hooks.keepsSyncHistory === undefined ? {} : { keepsSyncHistory: hooks.keepsSyncHistory }),
    ...(hooks.onHistoryMoved === undefined ? {} : { onHistoryMoved: hooks.onHistoryMoved }),
  }

  const manager =
    tier.kind === 'wal'
      ? createDurabilityManager(tier.config, managerHooks)
      : createSnapshotOnlyManager(tier.adapter, tier.config, managerHooks, hooks.checkpointPublisher)

  async function recordMutation(
    indexName: string,
    docId: string,
    operation: ReplicationOperation,
    document: Uint8Array | null,
    apply: ApplyMutation,
  ): Promise<DurableWrite> {
    return admitDurableWrite(hooks.getManager(indexName), async partitionCount => {
      const partitionId = fnv1a(docId) % partitionCount
      let queued: QueuedWrite | undefined
      try {
        const record: MutationRecord = {
          indexName,
          partitionId,
          operation,
          documentId: docId,
          document,
          async apply() {
            queued = (await apply()) ?? undefined
            if (queued !== undefined) deferMutationPublication(record)
          },
        }
        const seqNo = await manager.recordMutation(record)
        queued?.commit(partitionId, partitionCount, seqNo)
        return { indexName, partitionId, seqNo }
      } catch (error) {
        queued?.fail(error)
        throw error
      }
    })
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
      const queued: (QueuedWrite | undefined)[] = []
      for (let i = 0; i < mutations.length; i++) {
        if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
        const mutation = mutations[i]
        try {
          const record: MutationRecord = {
            indexName,
            partitionId: 0,
            operation: mutation.document === null ? 'DELETE' : 'INDEX',
            documentId: mutation.docId,
            document: mutation.document === null ? null : encodeDocument(mutation.document),
            async apply() {
              queued[i] = (await mutation.apply()) ?? undefined
              if (queued[i] !== undefined) deferMutationPublication(record)
            },
          }
          records.push(record)
          recordPositions.push(i)
        } catch (error) {
          outcomes[i] = { ok: false, error }
        }
      }
      return admitDurableWrite(hooks.getManager(indexName), async partitionCount => {
        let recorded: MutationOutcome[]
        try {
          for (const record of records) {
            record.partitionId = fnv1a(record.documentId) % partitionCount
          }
          recorded = await manager.recordMutations(records)
        } catch (error) {
          for (const entry of queued) entry?.fail(error)
          throw error
        }
        for (let i = 0; i < recorded.length; i++) {
          const outcome = recorded[i]
          const entry = queued[recordPositions[i]]
          if (outcome.ok) entry?.commit(records[i].partitionId, partitionCount, outcome.seqNo)
          else entry?.fail(outcome.error)
          outcomes[recordPositions[i]] = outcome.ok
            ? { ok: true, write: { indexName, partitionId: records[i].partitionId, seqNo: outcome.seqNo } }
            : outcome
        }
        return outcomes
      })
    },
    recordRemove(indexName: string, docId: string, apply: ApplyMutation): Promise<DurableWrite> {
      return recordMutation(indexName, docId, 'DELETE', null, apply)
    },
  }
}
