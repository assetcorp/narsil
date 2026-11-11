import { encodeJson } from '../json-encoding'
import type { ChangesSetting, ChangesStatus } from '../types/changes'
import { type ChangeFeedOptions, type ChangeSubscription, openChangeSubscription } from './change-feed'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readBody } from './response-shape'

/**
 * These methods read and replace the change capture setting of an index and follow its changes over the server's
 * change feed, as {@link ChangesOperations} does on the engine.
 *
 * @public
 */
export interface ChangesClientOperations {
  /**
   * Returns the change capture state of an index, as {@link ChangesOperations.getChanges} does on the engine.
   *
   * @param indexName - The server reports the state of this index.
   * @param options - This sets the signal, the deadline, and the headers for this request.
   * @returns The setting and the epoch.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` when no index has that name.
   */
  getChanges(indexName: string, options?: RequestOptions): Promise<ChangesStatus>
  /**
   * Replaces the change capture setting of an index, as {@link ChangesOperations.updateChanges} does on the engine.
   *
   * @param indexName - The server replaces the setting of this index.
   * @param setting - This is the new setting.
   * @param options - This sets the signal, the deadline, and the headers for this request.
   * @throws A `NarsilError` with `CHANGES_DURABILITY_REQUIRED` when the server's engine has no write-ahead log
   * durability, and with `CONFIG_INVALID` when a field has the wrong type or a history limit is not a positive whole
   * number.
   */
  updateChanges(indexName: string, setting: ChangesSetting, options?: RequestOptions): Promise<void>
  /**
   * Opens the change feed of an index and returns its events, as {@link ChangesOperations.followChanges} does on the
   * engine. The server serves the feed only where its `changes` option is on.
   *
   * The first event gives the epoch and the positions. Each later event holds the changes of one partition in
   * `seqNo` order, and the last event is a resync where the positions no longer lead to the index's changes. Save each
   * `scannedSeqNo` once you apply its changes, then acknowledge it with {@link ChangeSubscription.ack}.
   *
   * @param indexName - The server sends the changes of this index.
   * @param options - The epoch and positions to start from, a filter, a signal, and a credential.
   * @returns The subscription, which opens its connection at once.
   * @throws A `NarsilError` from the iteration with `CHANGES_NOT_ENABLED` when capture turns off, with the code in the
   * close reason when the index's setting refuses the subscription, with `CONFIG_INVALID` when the server refuses the
   * epoch, the positions, or the filter, and with `CLIENT_CONNECTION_FAILED` when the connection fails or the server
   * refuses it, in which case subscribe again from the saved positions.
   */
  followChanges(indexName: string, options?: ChangeFeedOptions): ChangeSubscription
}

export function createChangesClientOperations(transport: Transport): ChangesClientOperations {
  return {
    async getChanges(indexName, options) {
      const path = `${indexPath(indexName)}/changes`
      return readBody<ChangesStatus>(await transport.json({ method: 'GET', path, options }), path)
    },
    async updateChanges(indexName, setting, options) {
      const path = `${indexPath(indexName)}/changes`
      await transport.json({ method: 'PUT', path, body: encodeJson(setting), contentType: 'application/json', options })
    },
    followChanges(indexName, options = {}) {
      return openChangeSubscription(transport.socketUrl(`${indexPath(indexName)}/changes/feed`), options)
    },
  }
}
