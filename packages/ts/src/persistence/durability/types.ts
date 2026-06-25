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
}

export interface DurabilityManager {
  isActive(): boolean
  recover(): Promise<void>
  recordMutation(record: MutationRecord): Promise<number>
  markApplied(indexName: string, partitionId: number, seqNo: number): void
  persistMetadata(indexName: string): Promise<void>
  checkpoint(indexName: string): Promise<void>
  checkpointAll(): Promise<void>
  removeIndex(indexName: string): Promise<void>
  shutdown(): Promise<void>
}
