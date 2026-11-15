/**
 * The settings of the device sync routes, `GET /indexes/{name}/sync/snapshot`
 * and the feed at `GET /indexes/{name}/sync/feed`. Every field has a default.
 *
 * @public
 */
export interface ServerSyncOptions {
  /**
   * The server stops sending entries to a device while the entries that it
   * has sent, and that the device has not acknowledged, hold more than this
   * many bytes. It defaults to 8,388,608.
   */
  windowBytes?: number
  /** The server holds at most this many feed connections, and it answers 429 to one more. It defaults to 10,000. */
  maxConnections?: number
  /**
   * The server reads the history of at most this many feed connections at
   * once, and it holds any other connection until one of those reads ends.
   * It defaults to 32.
   */
  maxCatchUps?: number
  /**
   * The server stops reading entries for every feed while its feed
   * connections hold this many bytes that the network has not yet taken. It
   * defaults to 268,435,456.
   */
  maxBufferedBytes?: number
}

/**
 * The settings of the change feed at `GET /indexes/{name}/changes/feed`. Every
 * field has a default, and the server counts the connections and the
 * catch-ups of this feed apart from those of the device sync feed.
 *
 * @public
 */
export interface ServerChangesOptions {
  /**
   * The server stops sending changes to a subscriber while the changes that
   * it has sent, and that the subscriber has not acknowledged, hold more than
   * this many bytes. It defaults to 8,388,608.
   */
  windowBytes?: number
  /** The server holds at most this many change feed connections, and it answers 429 to one more. It defaults to 10,000. */
  maxConnections?: number
  /**
   * The server reads the history of at most this many change feed
   * connections at once, and it holds any other connection until one of
   * those reads ends. It defaults to 32.
   */
  maxCatchUps?: number
  /**
   * The server stops reading changes for every subscriber while its change
   * feed connections hold this many bytes that the network has not yet
   * taken. It defaults to 268,435,456.
   */
  maxBufferedBytes?: number
}
