import type { FilterExpression } from './filters'
import type { AnyDocument } from './schema'

/**
 * The change capture setting of one index, which {@link ChangesOperations.updateChanges} takes.
 *
 * A subscriber receives the documents of the whole index, so decide which callers may follow an index before you turn
 * capture on. A filter only chooses which changes a subscriber receives, and it grants no access.
 *
 * @public
 */
export interface ChangesSetting {
  /** This turns change capture on or off. Turning it on gives the index a new epoch unless device sync is on. */
  enabled: boolean
  /**
   * Set this to write into each log entry the document that the entry replaces or removes. A change then holds the
   * document before the write, and a subscription can hold a filter. It defaults to false, because the engine then
   * reads the stored document and writes it to the log again on every update and removal.
   */
  previousDocument?: boolean
  /** This is the age in milliseconds after which the engine deletes a log segment from history. It defaults to 30
   * days. */
  historyMaxAgeMs?: number
  /** This is the byte count above which the engine deletes the oldest log segment from history. It defaults to the
   * larger of the checkpoint's length and 1 GiB. */
  historyMaxBytes?: number
}

/**
 * The change capture state of one index, which {@link ChangesOperations.getChanges} returns.
 *
 * @public
 */
export interface ChangesStatus extends ChangesSetting {
  /** This is true when the engine writes the document before the write into each log entry. */
  previousDocument: boolean
  /** This is the index epoch, 32 lowercase hexadecimal digits, or `null` while capture is off. */
  epoch: string | null
}

/**
 * A subscriber's place in one partition of an index: the highest `seqNo` whose change it has applied.
 *
 * @public
 */
export interface ChangePosition {
  /** This is the partition that the position belongs to. */
  partitionId: number
  /** This is the sequence number of the last entry that the subscriber has examined in that partition. */
  seqNo: number
}

/**
 * What a write did to a document. A `put` comes from an entry that the engine wrote while `previousDocument` was off,
 * so it can be an insert or an update.
 *
 * @public
 */
export type ChangeType = 'put' | 'insert' | 'update' | 'remove'

/**
 * One write to an index, as {@link ChangesOperations.followChanges} returns it.
 *
 * @public
 */
export interface Change {
  /** This is the sequence number of the log entry within its partition. */
  seqNo: number
  /** This is what the write did to the document. */
  type: ChangeType
  /** This is the ID of the document that the write touched. */
  documentId: string
  /** This is the document after the write, with every field and every computed vector, and absent after a removal. */
  document?: AnyDocument
  /** This is the document before the write, present only for an update or a removal with `previousDocument` on. */
  previousDocument?: AnyDocument
}

/**
 * Where {@link ChangesOperations.followChanges} starts and which changes it returns.
 *
 * @public
 */
export interface FollowChangesOptions {
  /** This is the epoch that the positions belong to. Pass it together with `positions`, or leave both out. */
  epoch?: string
  /** This holds one position for each partition. Leave it out, with `epoch`, to start at the index's current heads. */
  positions?: ChangePosition[]
  /**
   * This keeps only the changes whose document before or after the write matches it, in the syntax of a query's
   * filters. It needs `previousDocument` on.
   */
  filter?: FilterExpression
  /** This ends the iteration when it aborts. */
  signal?: AbortSignal
}

/**
 * The first event of {@link ChangesOperations.followChanges}, which gives the positions that the changes follow.
 *
 * @public
 */
export interface ChangesSubscribed {
  /** This marks the event. */
  type: 'subscribed'
  /** This is the index's epoch. Save it with the positions. */
  epoch: string
  /** This is the number of partitions, each of which has a position. */
  partitionCount: number
  /** These are the positions that the changes follow. */
  positions: ChangePosition[]
  /** These are the heads of the partitions when the subscription started. */
  heads: ChangePosition[]
  /** This is the length in bytes of the history and log between the positions and the heads. */
  bytesBehind: number
  /** This is true when a change can hold the document before the write. */
  previousDocument: boolean
}

/**
 * A group of changes from one partition. Apply the changes, then save `scannedSeqNo` as the partition's position.
 *
 * @public
 */
export interface ChangesBatch {
  /** This marks the event. */
  type: 'changes'
  /** This is the partition that the changes come from. */
  partitionId: number
  /** These are the changes in `seqNo` order, which can be empty under a filter. */
  changes: Change[]
  /** This is the highest `seqNo` of the partition that the engine examined, which is the next position to save. */
  scannedSeqNo: number
}

/**
 * The last event of {@link ChangesOperations.followChanges} when the positions no longer lead to the index's changes.
 * Export the index, replace your copy with the export's documents, and follow again from the export's header.
 *
 * @public
 */
export interface ChangesResync {
  /** This marks the event. */
  type: 'resync'
  /**
   * This is `epoch` when the index has a new epoch, `history` when the history no longer holds the entries above a
   * position, and `ahead` when a position lies above every entry of its partition.
   */
  reason: 'epoch' | 'history' | 'ahead'
}

/**
 * One event of {@link ChangesOperations.followChanges}.
 *
 * @public
 */
export type ChangesEvent = ChangesSubscribed | ChangesBatch | ChangesResync

/**
 * The methods that turn change capture on and off for an index and follow its changes.
 *
 * @public
 */
export interface ChangesOperations {
  /**
   * Replaces the change capture setting of an index.
   *
   * Turning capture on gives the index a new epoch unless device sync is on, and the engine keeps the log segments
   * that a checkpoint covers as history from then on. Turning it off ends every follower of the index and deletes the
   * history unless a device has asked for the index's sync snapshot. The engine saves the setting with the index, and
   * no snapshot of the index includes it.
   *
   * @param indexName - The index whose setting the engine replaces.
   * @param setting - The new setting.
   * @throws A `NarsilError` with `CHANGES_DURABILITY_REQUIRED` when the engine has no write-ahead log durability, and
   * with `CONFIG_INVALID` when a field has the wrong type or a history limit is not a positive whole number.
   */
  updateChanges(indexName: string, setting: ChangesSetting): Promise<void>
  /**
   * Returns the change capture state of an index.
   *
   * @param indexName - The index whose state the engine returns.
   * @returns The setting and the epoch.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` when no index has that name.
   */
  getChanges(indexName: string): Promise<ChangesStatus>
  /**
   * Returns the changes of an index above a list of positions, and then each later change as the log makes it
   * durable, until the signal aborts or the caller stops iterating.
   *
   * The first event gives the epoch and the positions. Each later event holds the changes of one partition in `seqNo`
   * order. Where the positions no longer lead to the index's changes, the last event is a resync.
   *
   * @param indexName - The index whose changes the engine returns.
   * @param options - The epoch and positions to start from, a filter, and a signal.
   * @returns The events, one at a time.
   * @throws A `NarsilError` with `CHANGES_NOT_ENABLED` when capture is off or turns off, with
   * `CHANGES_INVALID_POSITIONS` for a malformed epoch or list of positions, with `SEARCH_INVALID_FILTER` for a filter
   * that breaks the shape or the limits of a query's filters, with `SEARCH_INVALID_FIELD` for a filter that tests a
   * field which the schema leaves out, and with `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` for a filter while
   * `previousDocument` is off.
   */
  followChanges(indexName: string, options?: FollowChangesOptions): AsyncIterable<ChangesEvent>
}
