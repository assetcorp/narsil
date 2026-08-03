/**
 * Where the engine writes partitions so that they outlive the process.
 *
 * Every method addresses a partition by an opaque key, so any key-value store
 * works: memory, the filesystem, IndexedDB, or a service you write yourself.
 * The engine never interprets a key beyond the prefix it lists by.
 *
 * @public
 */
export interface PersistenceAdapter {
  /**
   * Writes one partition, replacing whatever the key already held.
   *
   * @param key - The key the engine reads this partition back under.
   * @param data - The serialised partition.
   */
  save(key: string, data: Uint8Array): Promise<void>
  /**
   * Reads one partition back.
   *
   * @param key - The key a matching {@link PersistenceAdapter.save} wrote.
   * @returns The stored bytes, or `null` when the key holds nothing.
   */
  load(key: string): Promise<Uint8Array | null>
  /**
   * Removes one partition. A key that holds nothing is not an error.
   *
   * @param key - The key to clear.
   */
  delete(key: string): Promise<void>
  /**
   * Lists the keys the store holds under a prefix, which is how the engine
   * finds an index's partitions on start-up.
   *
   * @param prefix - Matched against the start of each key.
   * @returns Every matching key, in any order.
   */
  list(prefix: string): Promise<string[]>
  /** This adapter writes to this directory, when a filesystem backs it. */
  readonly directory?: string
}

/**
 * Carries partition changes between engine instances that share one store.
 *
 * Two processes reading the same persisted index each hold their own copy in
 * memory, so a write in one has to reach the other. Publish an event on every
 * write and each subscriber reloads the partitions that event names.
 *
 * @public
 */
export interface InvalidationAdapter {
  /**
   * Broadcasts one change to every other subscriber.
   *
   * @param event - The partitions that changed, or the statistics that moved.
   */
  publish(event: InvalidationEvent): Promise<void>
  /**
   * Starts delivering the events other instances publish.
   *
   * @param handler - Called once per event.
   */
  subscribe(handler: (event: InvalidationEvent) => void): Promise<void>
  /** Closes the channel and releases whatever it held open. */
  shutdown(): Promise<void>
}

/**
 * What one instance tells the others about a change it made.
 *
 * A `partition` event names the partitions a subscriber must reload. A
 * `statistics` event carries the term counts that keep BM25 scores comparable
 * across instances.
 *
 * @public
 */
export type InvalidationEvent =
  | {
      /** This marks the event as a set of partitions to reload. */
      type: 'partition'
      /** The partitions belong to this index. */
      indexName: string
      /** These partition ids changed. */
      partitions: number[]
      /** The publisher stamped the event at this many milliseconds since the epoch, which lets a subscriber drop a late one. */
      timestamp: number
      /** This instance published the event, so a subscriber can skip its own. */
      sourceInstanceId: string
    }
  | {
      /** This marks the event as a statistics update. */
      type: 'statistics'
      /** The statistics describe this index. */
      indexName: string
      /** The statistics were measured on this instance. */
      instanceId: string
      /** That instance holds these term counts. */
      stats: PartitionStatistics
    }

/**
 * The term counts one instance holds, which the others fold into their own so
 * that BM25 scores stay comparable across a shared index.
 *
 * @public
 */
export interface PartitionStatistics {
  /** This instance holds this many documents for the index. */
  totalDocs: number
  /** Each term appears in this many documents, keyed by term. */
  docFrequencies: Record<string, number>
  /** Each field holds this many tokens in total, which gives BM25 its average field length. */
  totalFieldLengths: Record<string, number>
}

/**
 * Turns text into vectors, so an index embeds documents as they arrive and
 * embeds a query as it runs.
 *
 * Write one against any model you like. The engine calls it on every write to
 * a field the index maps, and on every vector query that passes `text`.
 *
 * @public
 */
export interface EmbeddingAdapter {
  /**
   * Embeds one string.
   *
   * @param input - The text to embed.
   * @param purpose - `document` on a write and `query` on a search, which lets
   * an asymmetric model pick the right prompt or prefix.
   * @param signal - Aborts a call the engine no longer needs.
   * @returns The vector, whose length must equal
   * {@link EmbeddingAdapter.dimensions}.
   */
  embed(input: string, purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array>
  /**
   * Embeds many strings in one call, which a batch load uses when the adapter
   * offers it. The engine falls back to {@link EmbeddingAdapter.embed} per
   * item when it is absent.
   *
   * @param inputs - The texts to embed.
   * @param purpose - `document` on a write and `query` on a search.
   * @param signal - Aborts a call the engine no longer needs.
   * @returns One vector per input, in the same order.
   */
  embedBatch?(inputs: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>
  /** Every vector this adapter returns is this long, which must match the schema's `vector[N]`. */
  readonly dimensions: number
  /** Releases whatever the adapter holds open, such as a model or a connection pool. */
  shutdown?(): Promise<void>
}
