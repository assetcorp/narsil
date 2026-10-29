import type { ReplicationLogEntry, ReplicationOperation } from '../../distribution/replication/types'
import type { PartitionManager } from '../../partitioning/manager'
import type { DurabilityConfig } from '../../types/config'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'
import type { ArchiveCheckpoint } from './archive-checkpoint'
import type { LayoutUpgradeEvent } from './earlier-layout/upgrade'
import type { PartitionCheckpoint } from './partition-checkpoint'
import type { PartitionRegistry } from './partition-registry'
import type { RestoreStaging } from './restore-staging'

export type { DurabilityConfig }

export interface IndexDurabilityHooks {
  getManager(indexName: string): PartitionManager | undefined
  getVectorFieldPaths(indexName: string): Set<string>
  getVectorIndexes(indexName: string): Map<string, VectorIndex>
  buildMetadata(indexName: string, documentCount?: number): IndexMetadata | undefined
  createIndexFromMetadata(metadata: IndexMetadata, loadData: boolean): Promise<void>
  recordCheckpoint?(indexName: string, documentCount: number, partitionCount: number): void
  onLayoutUpgrade?(event: LayoutUpgradeEvent): void
  onFatalError(error: Error): void
}

export interface MutationRecord {
  indexName: string
  partitionId: number
  operation: ReplicationOperation
  documentId: string
  document: Uint8Array | null
  apply: () => void | Promise<void>
  replicated?: ReplicationLogEntry
}

export type MutationOutcome = { ok: true; seqNo: number } | { ok: false; error: unknown }

export type EntryNumbering = (record: MutationRecord) => ReplicationLogEntry | null

export type CommitDeferral = (record: MutationRecord) => boolean

export interface PartitionLogPosition {
  seqNo: number
  primaryTerm: number
}

export interface DurabilityManager {
  isActive(): boolean
  recover(metadataOnly?: boolean): Promise<void>
  recoverIndex(indexName: string): Promise<void>
  recordMutation(record: MutationRecord): Promise<number>
  recordMutations(records: readonly MutationRecord[]): Promise<MutationOutcome[]>
  /** The highest sequence number this node's own write-ahead log holds for a partition, counting what recovery
   * replayed. */
  highestPersistedSeqNo(indexName: string, partitionId: number): number
  readonly partitionRegistry?: PartitionRegistry
  numberEntriesWith?(numbering: EntryNumbering, defersCommit?: CommitDeferral): void
  commitPartition?(indexName: string, partitionId: number): Promise<void>
  /** Writes the index metadata. Each index takes its writes in turn, so a caller that built its metadata earlier
   * never renames over a later one. */
  persistMetadata(indexName: string): Promise<void>
  checkpoint(indexName: string): Promise<void>
  /** Writes each partition as it stands in memory, so a checkpoint that
   * rebuilt its terms replaces what earlier segments hold. */
  checkpointFromMemory?(indexName: string): Promise<void>
  checkpointAll(): Promise<void>
  openArchiveCheckpoint?(indexName: string): Promise<ArchiveCheckpoint>
  stageRestore?(indexName: string): RestoreStaging
  adoptRestoredCheckpoint?(indexName: string, checkpoint: readonly PartitionCheckpoint[]): void
  removeIndex(indexName: string): Promise<void>
  unloadIndex(indexName: string): Promise<void>
  reloadIndex?(indexName: string): Promise<void>
  shutdown(): Promise<void>
}

export interface CheckpointPublisher {
  publishPartitions(indexName: string, partitions: number[]): Promise<void>
}
