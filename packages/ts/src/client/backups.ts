import type { BackupListing, DamagedBackup } from '../distribution/backups/types'
import { encodeJson } from '../json-encoding'
import type { CreateBackupBody, RestoreBackupBody, TaskRecord } from '../server/types'
import { NO_TIMEOUT } from './constants'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { backupPath, indexPath } from './paths'
import { readArray, readBody } from './response-shape'

/**
 * These methods back up an index to the store outside the cluster, list and delete the backups there, and restore one
 * as a new index. A server that fronts a cluster node with a backup store answers them.
 *
 * Each method except {@link BackupOperations.listBackups} answers with a {@link TaskRecord} while the work continues,
 * and the task's `steps` report how many partitions, or how many files for a deletion, are done. Follow that task with
 * {@link TaskOperations.waitForTask}.
 *
 * @public
 */
export interface BackupOperations {
  /**
   * Starts a backup of an index, which holds every write that the cluster acknowledged before the backup started.
   *
   * @param indexName - This names the index to back up.
   * @param backupName - This names the backup, with 1 to 128 letters, digits, `.`, `_`, and `-`, starting with a
   * letter or a digit.
   * @param options - This sets the signal, the deadline, and the headers for this request. Set `queryHistory` to add
   * every node's popular query suggestion history of the index, which holds raw searches, to the backup.
   * @returns The record is the task to follow.
   * @throws A `NarsilError` with `CLUSTER_OPERATION_UNSUPPORTED` from a server that fronts a single engine. The task
   * reports `BACKUP_ALREADY_EXISTS` or `BACKUP_DURABILITY_REQUIRED` in its `error`.
   */
  createBackup(
    indexName: string,
    backupName: string,
    options?: RequestOptions & Pick<CreateBackupBody, 'queryHistory'>,
  ): Promise<TaskRecord>
  /**
   * Lists the backups under the cluster's key prefix, in name order.
   *
   * @param options - This sets the signal, the deadline, and the headers for this request.
   * @returns One summary per backup, and a {@link DamagedBackup} with `BACKUP_DAMAGED` for each manifest that the
   * cluster can't read.
   */
  listBackups(options?: RequestOptions): Promise<BackupListing[]>
  /**
   * Starts the restore of a backup as a new index, on a cluster of any size.
   *
   * @param backupName - This names the backup to restore.
   * @param restore - This names the new index, and it can set the replication factor and the allocation constraints in
   * place of the backup's.
   * @param options - This sets the signal, the deadline, and the headers for this request.
   * @returns The record is the task to follow.
   * @throws A `NarsilError` with `CLUSTER_OPERATION_UNSUPPORTED` from a server that fronts a single engine. The task
   * reports `BACKUP_NOT_FOUND`, `BACKUP_DAMAGED`, or `INDEX_ALREADY_EXISTS` in its `error`, and a failed restore
   * creates no index.
   */
  restoreBackup(backupName: string, restore: RestoreBackupBody, options?: RequestOptions): Promise<TaskRecord>
  /**
   * Starts the deletion of a backup, which also removes each of its files that no other backup lists.
   *
   * @param backupName - This names the backup to delete.
   * @param options - This sets the signal, the deadline, and the headers for this request.
   * @returns The record is the task to follow.
   * @throws A `NarsilError` with `CLUSTER_OPERATION_UNSUPPORTED` from a server that fronts a single engine. The task
   * reports `BACKUP_NOT_FOUND` in its `error`.
   */
  deleteBackup(backupName: string, options?: RequestOptions): Promise<TaskRecord>
}

export function createBackupOperations(transport: Transport): BackupOperations {
  async function postTask(path: string, body: unknown, options: RequestOptions | undefined): Promise<TaskRecord> {
    const payload = await transport.json({
      method: 'POST',
      path,
      body: encodeJson(body),
      contentType: 'application/json',
      options,
    })
    return readBody<TaskRecord>(payload, path)
  }

  return {
    createBackup(indexName, backupName, options) {
      const { queryHistory, ...request } = options ?? {}
      const body: CreateBackupBody = { backup: backupName, ...(queryHistory === true ? { queryHistory } : {}) }
      return postTask(`${indexPath(indexName)}/backups`, body, request)
    },
    async listBackups(options) {
      const path = '/backups'
      const payload = await transport.json({ method: 'GET', path, defaultTimeoutMs: NO_TIMEOUT, options })
      return readArray<BackupListing>(payload, 'backups', path)
    },
    restoreBackup(backupName, restore, options) {
      return postTask(`${backupPath(backupName)}/_restore`, restore, options)
    },
    async deleteBackup(backupName, options) {
      const path = backupPath(backupName)
      return readBody<TaskRecord>(await transport.json({ method: 'DELETE', path, options }), path)
    },
  }
}
