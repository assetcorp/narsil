/**
 * Tells watchers that the stored metadata of an index changed.
 *
 * @public
 */
export interface IndexMetadataEvent {
  /** This index's metadata changed. */
  indexName: string
  /** These are the bytes of the new value, and they are `null` when the index was dropped. */
  metadata: Uint8Array | null
}

/**
 * The coordinator's watch of index metadata.
 *
 * @public
 */
export interface IndexMetadataWatch {
  /**
   * Watches the stored metadata of every index, under the key that
   * `_narsil/index/{indexName}/config` describes, and under no other key.
   *
   * For each key, the handler receives the values in the order that the store
   * wrote them. After a lost connection, the coordinator lists the current
   * values and delivers each one that changed, so a handler can miss an
   * intermediate value and always receives the last one. A value that was
   * written before the watch started fires nothing, so read what you need
   * after the watch starts.
   *
   * @param handler - Called once per change.
   * @returns A function that ends the watch.
   */
  watchIndexMetadata(handler: (event: IndexMetadataEvent) => void): Promise<() => void>
}
