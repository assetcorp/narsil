import type { BackupListing } from '../../distribution/backups/types'
import type { AllocationConstraints } from '../../distribution/coordinator/types'

/**
 * The body of `POST /indexes/{name}/backups`.
 *
 * @public
 */
export interface CreateBackupBody {
  /** The backup's name, from 1 to 128 letters, digits, `.`, `_`, and `-`, starting with a letter or a digit. */
  backup: string
}

/**
 * The body of `POST /backups/{backup}/_restore`.
 *
 * @public
 */
export interface RestoreBackupBody {
  /** The restore creates the index under this name, and it fails where the name is taken. */
  indexName: string
  /** The restored index keeps this many replicas of each partition, or the backup's number when you leave it out. */
  replicationFactor?: number
  /** The rules that place the restored partitions, or the backup's rules when you leave them out. */
  constraints?: AllocationConstraints
}

/**
 * The body of `GET /backups`.
 *
 * @public
 */
export interface BackupListResponse {
  /** One entry per backup in name order: its summary, or its name and a `BACKUP_DAMAGED` error where its manifest can't be read. */
  backups: BackupListing[]
}
