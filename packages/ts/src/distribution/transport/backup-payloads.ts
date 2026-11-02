import type { BackupPartition, StoredFile } from '../backups/manifest'
import type { AllocationConstraints } from '../coordinator/types'

export interface BackupRequestPayload {
  backupName: string
  indexName: string
}

export interface BackupRestoreRequestPayload {
  backupName: string
  indexName: string
  replicationFactor?: number
  constraints?: AllocationConstraints
}

export interface BackupDeleteRequestPayload {
  backupName: string
}

export interface BackupRequestResultPayload {
  jobId: string
}

export interface PartitionTaskPayload {
  jobId: string
  backupName: string
  indexName: string
  partitionId: number
}

export interface BackupPartitionResult {
  partition: BackupPartition
  config: StoredFile
  filesStored: number
  bytesStored: number
}

export type PartitionTaskStatus = 'running' | 'done' | 'failed'

export interface PartitionTaskReply<T> {
  jobId: string
  partitionId: number
  status: PartitionTaskStatus
  result?: T
  error?: { code: string; message: string }
}
