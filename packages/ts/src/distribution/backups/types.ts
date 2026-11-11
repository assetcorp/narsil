import type { PersistenceAdapter } from '../../types/adapters'
import type { AllocationConstraints } from '../coordinator/types'

/**
 * Where a cluster keeps its backups, which is a store outside the cluster.
 *
 * Give every node of the cluster the same settings, because the primary of each partition uploads that
 * partition's files and the controller writes each backup's manifest.
 *
 * @public
 */
export interface ClusterBackupConfig {
  /** The store that holds the backups, such as the adapter from `@delali/narsil/adapters/s3`. */
  store: PersistenceAdapter
  /**
   * This cluster writes every backup under this key prefix, and it refuses to write under a prefix that another
   * cluster has written to. Use segments of letters, digits, `.`, `_`, and `-`, joined by `/`.
   */
  keyPrefix: string
}

/**
 * What a cluster records about one backup.
 *
 * @public
 */
export interface BackupSummary {
  /** The name the backup was taken under. */
  name: string
  /** The index the backup holds. */
  indexName: string
  /** The backup started at this many milliseconds since the epoch, and it holds every write acknowledged before then. */
  startedAt: number
  /** The controller wrote the backup's manifest at this many milliseconds since the epoch. */
  completedAt: number
  /** The index had this many partitions, and a restore creates the same number. */
  partitionCount: number
  /** The index kept this many replicas of each partition, and a restore asks for the same number. */
  replicationFactor: number
  /** The backup lists this many stored files, counting each partition's manifest and the index configuration. */
  files: number
  /** The files the backup lists hold this many bytes in total, including files that other backups share. */
  bytes: number
}

/**
 * How far a backup, a restore, or a deletion has gone.
 *
 * @public
 */
export interface BackupProgress {
  /** The operation has finished this many partitions, or this many files for a deletion. */
  done: number
  /** The operation covers this many partitions, or this many files for a deletion, and 0 until it knows. */
  total: number
}

/**
 * Options that every backup operation takes.
 *
 * @public
 */
export interface BackupOperationOptions {
  /** Called whenever the operation reports more progress. */
  onProgress?: (progress: BackupProgress) => void
}

/**
 * How {@link ClusterNamespace.createBackup} backs up an index.
 *
 * @public
 */
export interface CreateBackupOptions extends BackupOperationOptions {
  /**
   * Set this to true to add every node's popular query suggestion history of the index to the backup, so that a
   * restore keeps the counts that a build reads. The history holds the scrambled text of what people searched for, and
   * the backup keeps it after `retentionDays` ends, so leave it out unless the restored index needs those counts. A
   * node that gives no answer adds nothing.
   */
  queryHistory?: boolean
}

/**
 * Where {@link ClusterNamespace.restoreBackup} puts a backup, and how the cluster places the restored copies.
 *
 * @public
 */
export interface RestoreBackupOptions extends BackupOperationOptions {
  /** The restore creates the index under this name, and it fails where the name is taken. */
  indexName: string
  /** The restored index keeps this many replicas of each partition, or the backup's number when you leave it out. */
  replicationFactor?: number
  /** The rules that place the restored partitions, or the backup's rules when you leave them out. */
  constraints?: AllocationConstraints
}

/**
 * A backup whose manifest the cluster can't read, which a listing shows in place of its summary.
 *
 * @public
 */
export interface DamagedBackup {
  /** The name that the manifest is stored under. */
  name: string
  /** Why the manifest can't be read, with the code `BACKUP_DAMAGED`. */
  error: { code: string; message: string }
}

/**
 * One entry of {@link ClusterNamespace.listBackups}: a summary, or a {@link DamagedBackup} where the manifest can't be
 * read.
 *
 * @public
 */
export type BackupListing = BackupSummary | DamagedBackup
