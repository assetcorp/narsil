import type { ChangesEvent, ChangesSetting, ChangesStatus, FollowChangesOptions } from '../../../types/changes'

/**
 * Turns change capture on and off for an index across a cluster, follows its changes, and exports its documents.
 *
 * @public
 */
export interface ClusterNodeChanges {
  /**
   * Replaces the change capture setting of an index across the cluster.
   *
   * Turning capture on gives the index a new epoch unless device sync is on. Turning it off makes every node delete the
   * history of its copies unless device sync is on, and close every change feed of the index. The node stores the
   * setting in the index metadata, so every node applies it through its metadata watch.
   *
   * @param indexName - The index whose setting the cluster replaces.
   * @param setting - The new setting.
   * @throws A `NarsilError` with `CHANGES_BACKUP_STORE_REQUIRED` when the cluster has no backup store, with
   * `CHANGES_DURABILITY_REQUIRED` when this node has no write-ahead log durability, with `CHANGES_NOT_READY` while a
   * registered node has a specification version below 1.5, with `CONFIG_INVALID` when a field has the wrong type or a
   * history limit is not a positive whole number, and with `INDEX_NOT_FOUND` when no index has that name.
   */
  updateChanges(indexName: string, setting: ChangesSetting): Promise<void>
  /**
   * Returns the change capture state of an index, as the index metadata holds it.
   *
   * @param indexName - The index whose state the cluster returns.
   * @returns The setting and the epoch.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` when no index has that name.
   */
  getChanges(indexName: string): Promise<ChangesStatus>
  /**
   * Returns the changes of an index above a list of positions, read from each partition's primary up to the point
   * that every replica has acknowledged, and then each later change, until the signal aborts or the caller stops
   * iterating.
   *
   * The first event gives the epoch and the positions. Each later event holds the changes of one partition in `seqNo`
   * order. Where the positions no longer lead to the index's changes, the last event is a resync.
   *
   * @param indexName - The index whose changes the cluster returns.
   * @param options - The epoch and positions to start from, a filter, and a signal.
   * @returns The events, one at a time.
   * @throws A `NarsilError` with `CHANGES_NOT_ENABLED` when capture is off or turns off, with `CHANGES_NOT_READY` while
   * a registered node has a specification version below 1.5, with `CHANGES_INVALID_POSITIONS` for a malformed epoch or
   * list of positions, with `SEARCH_INVALID_FILTER` for a filter that breaks the shape or the limits of a query's
   * filters, with `SEARCH_INVALID_FIELD` for a filter that tests a field which the schema leaves out, and with
   * `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` for a filter while `previousDocument` is off.
   */
  followChanges(indexName: string, options?: FollowChangesOptions): AsyncIterable<ChangesEvent>
  /**
   * Returns every document of an index with change capture on, as the newest backup of its epoch holds them, after a
   * header that gives the epoch and the position of each partition at that backup.
   *
   * @param indexName - The index whose documents the cluster exports.
   * @returns The export as a stream of JSON lines.
   * @throws A `NarsilError` with `CHANGES_EXPORT_PREPARING` while the cluster takes the backup that the export needs,
   * with `CHANGES_BACKUP_STORE_REQUIRED` when the cluster has no backup store, and with
   * `CLUSTER_OPERATION_UNSUPPORTED` when change capture is off.
   */
  exportDocuments(indexName: string): Promise<ReadableStream<Uint8Array>>
}
