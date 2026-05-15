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

export interface ReplicationConfig {
  logRetentionBytes: number
  waitForActiveReplicas: number
}

export interface ReplicationLog {
  append(entry: Omit<ReplicationLogEntry, 'seqNo' | 'checksum'>): ReplicationLogEntry
  getEntriesFrom(fromSeqNo: number): ReplicationLogEntry[]
  getEntry(seqNo: number): ReplicationLogEntry | undefined
  verifyChecksum(entry: ReplicationLogEntry): boolean
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
  error?: string
}
