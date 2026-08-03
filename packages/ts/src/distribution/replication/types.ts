import type { ErrorCode } from '../../errors'

export type ReplicationOperation = 'INDEX' | 'DELETE'

export interface ReplicationLogEntry {
  seqNo: number
  primaryTerm: number
  operation: ReplicationOperation
  partitionId: number
  indexName: string
  documentId: string
  document: Uint8Array | null
  checksum: number
}

/**
 * How much replication history a primary keeps, and how many replicas have to
 * confirm a write before it is acknowledged.
 *
 * A replica that falls further behind than the retained log recovers from a
 * whole snapshot instead of replaying entries, so a larger retention trades
 * memory for cheaper recovery.
 *
 * @public
 */
export interface ReplicationConfig {
  /** A primary keeps this many bytes of replication log before it drops the oldest entries. */
  logRetentionBytes: number
  /** This many replicas must acknowledge a write before the primary reports it as done. */
  waitForActiveReplicas: number
}

export interface ReplicationLog {
  append(entry: Omit<ReplicationLogEntry, 'seqNo' | 'checksum'>): ReplicationLogEntry
  appendCommitted(entry: ReplicationLogEntry): ReplicationLogEntry
  getEntriesFrom(fromSeqNo: number): ReplicationLogEntry[]
  getEntry(seqNo: number): ReplicationLogEntry | undefined
  verifyChecksum(entry: ReplicationLogEntry): boolean
  readonly committedSeqNo: number
  readonly committedPrimaryTerm: number
  readonly oldestSeqNo: number | undefined
  readonly newestSeqNo: number | undefined
  readonly entryCount: number
  readonly sizeBytes: number
  clear(): void
}

export const DEFAULT_LOG_RETENTION_BYTES = 268_435_456

export interface ReplicateResult {
  acknowledged: string[]
  failed: string[]
}

export interface EntryValidation {
  valid: boolean
  error?: ErrorCode
}
