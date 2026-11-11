/**
 * The device sync setting of one index, which {@link SyncOperations.updateSync} takes.
 *
 * Turn sync on only for an index whose every document belongs to one user, because every device that syncs the index
 * receives the whole index. Create one index for each user, and leave sync off for a public index or for an index that
 * holds the data of several users.
 *
 * @public
 */
export interface SyncSetting {
  /** This turns sync on or off. Turning it on gives the index a new epoch, so every synced device loads a new copy. */
  enabled: boolean
  /** This is the age in milliseconds after which the server deletes a log segment from history. It defaults to 30
   * days. */
  historyMaxAgeMs?: number
  /** This is the byte count above which the server deletes the oldest log segment from history. It defaults to the
   * length of the published snapshot. */
  historyMaxBytes?: number
}

/**
 * The device sync state of one index, which {@link SyncOperations.getSync} returns.
 *
 * @public
 */
export interface SyncStatus extends SyncSetting {
  /** This is true once a device has asked for the published snapshot, from when the server keeps history. */
  active: boolean
  /** This is the index epoch, 32 lowercase hexadecimal digits, or `null` while sync is off. */
  epoch: string | null
}

/**
 * The methods that turn device sync on and off for an index.
 *
 * @public
 */
export interface SyncOperations {
  /**
   * Replaces the device sync setting of an index.
   *
   * Turning sync on gives the index a new epoch. Changing a history limit while sync is on keeps the epoch. Turning
   * sync off deletes the published snapshot and the history, and the server closes every feed of the index with
   * close code 4410. The engine saves the setting with the index, so the setting stays in place after a restart, and
   * no snapshot of the index includes it.
   *
   * @param indexName - The index whose setting the engine replaces.
   * @param setting - The new setting.
   * @throws A `NarsilError` with `SYNC_DURABILITY_REQUIRED` when the engine has no write-ahead log durability, and
   * with `CONFIG_INVALID` when a history limit is not a positive whole number.
   */
  updateSync(indexName: string, setting: SyncSetting): Promise<void>
  /**
   * Returns the device sync state of an index.
   *
   * @param indexName - The index whose state the engine returns.
   * @returns The setting, whether a device has asked for the snapshot, and the epoch.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` when no index has that name.
   */
  getSync(indexName: string): Promise<SyncStatus>
}
