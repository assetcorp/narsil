import type { ReplicationOperation } from '../../distribution/replication/types'
import type { PartitionManager } from '../../partitioning/manager'
import type { DurabilityConfig } from '../../types/config'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'

export type { DurabilityConfig }

export const DEFAULT_CHECKPOINT_INTERVAL_MS = 300_000
export const DEFAULT_CHECKPOINT_MUTATION_THRESHOLD = 100_000

export interface IndexDurabilityHooks {
  getManager(indexName: string): PartitionManager | undefined
  getVectorFieldPaths(indexName: string): Set<string>
  getVectorIndexes(indexName: string): Map<string, VectorIndex>
  buildMetadata(indexName: string): IndexMetadata | undefined
  createIndexFromMetadata(metadata: IndexMetadata): Promise<void>
  onFatalError(error: Error): void
}

export interface MutationRecord {
  indexName: string
  partitionId: number
  operation: ReplicationOperation
  documentId: string
  document: Uint8Array | null
  apply: () => void | Promise<void>
}

export interface DurabilityManager {
  isActive(): boolean
  recover(): Promise<void>
  recordMutation(record: MutationRecord): Promise<number>
  /** The highest sequence number this node's own write-ahead log holds for a partition, counting what recovery
   * replayed. A replicated write reaches the partition without passing through this log, so a node that took the
   * partition on as a replica reports 0. */
  highestPersistedSeqNo(indexName: string, partitionId: number): number
  /** Writes the index metadata. Each index takes its writes in turn, so a caller that built its metadata earlier
   * never renames over a later one. */
  persistMetadata(indexName: string): Promise<void>
  checkpoint(indexName: string): Promise<void>
  /** Writes each partition as it stands in memory, so a checkpoint that
   * rebuilt its terms replaces what earlier segments hold. */
  checkpointFromMemory?(indexName: string): Promise<void>
  checkpointAll(): Promise<void>
  removeIndex(indexName: string): Promise<void>
  reloadIndex?(indexName: string): Promise<void>
  shutdown(): Promise<void>
}

export interface CheckpointPublisher {
  publishPartitions(indexName: string, partitions: number[]): Promise<void>
}
