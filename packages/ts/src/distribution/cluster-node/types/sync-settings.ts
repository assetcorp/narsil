import type { SyncSetting, SyncStatus } from '../../../types/sync'

/**
 * Turns device sync on and off for an index across a cluster.
 *
 * @public
 */
export interface ClusterNodeSyncSettings {
  /**
   * Replaces the device sync setting of an index across the cluster.
   *
   * Turning sync on gives the index a new epoch. Changing a history limit while sync is on keeps the epoch. Turning
   * sync off makes every node delete the history of its copies and close every feed of the index with close code
   * 4410. The node stores the setting in the index metadata, so every node applies it through its metadata watch.
   *
   * @param indexName - The index whose setting the cluster replaces.
   * @param setting - The new setting.
   * @throws A `NarsilError` with `SYNC_BACKUP_STORE_REQUIRED` when the cluster has no backup store, with
   * `SYNC_DURABILITY_REQUIRED` when this node has no write-ahead log durability, with `SYNC_NOT_READY` while a
   * registered node has a specification version below 1.3, with `CONFIG_INVALID` when a history limit is not a
   * positive whole number, and with `INDEX_NOT_FOUND` when no index has that name.
   */
  updateSync(indexName: string, setting: SyncSetting): Promise<void>
  /**
   * Returns the device sync state of an index, as the index metadata holds it.
   *
   * @param indexName - The index whose state the cluster returns.
   * @returns The setting, whether a device has asked for the snapshot, and the epoch.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` when no index has that name.
   */
  getSync(indexName: string): Promise<SyncStatus>
}
