/**
 * This map lists every event that the engine emits, with the payload of each
 * one.
 *
 * {@link Narsil.on} registers a listener under a key from this map, so that the
 * engine can pass the matching payload to that listener. Most of these events
 * report work that the engine does in the background, away from the call that
 * started it, so a failure that such an event reports never rejects a promise
 * that you are holding.
 *
 * @public
 */
export type NarsilEventMap = {
  /**
   * The engine emits this event after a call changes what a read returns from
   * an index. The calls are the inserts, updates, and removals, singly or in a
   * batch, together with `clear`, `restore`, `rebalance`, `rebuildAnalysis`,
   * `compactVectors`, `optimizeVectors`, `createIndex`, and `dropIndex`. The
   * engine emits the event after a call that throws as well, because a call can
   * change the index before it throws. It also emits the event after it reloads
   * an index, once a shared invalidation adapter reports that another instance
   * saved that index. The engine emits one event per batch, however many
   * documents the batch holds.
   *
   * The engine emits the event once a query can see the change, which means
   * after every worker copy applies the change and after any rebalance in
   * progress replays it. A query that a listener sends from its handler
   * therefore returns results that include the change. The engine waits for the
   * change to become visible only while a listener is registered for the event.
   */
  write: {
    /** This is the name of the index that changed. */
    indexName: string
  }
  /**
   * A worker thread exited unexpectedly. The pool removes the thread and fails
   * the requests that the thread was serving with `WORKER_CRASHED`. The engine
   * then sends each of those queries again on the main thread, so the caller
   * receives a result with no error. The remaining workers keep serving
   * queries, because each of them holds a full worker copy of every promoted
   * index.
   *
   * After a delay, the engine spawns a replacement and loads every copy onto
   * it before it sends queries to the replacement. Once no worker is left, the
   * main thread serves every query, because it holds every document. The first
   * request after the delay then starts a new pool. The delay starts at one
   * second and doubles up to a minute while replacements keep failing.
   */
  workerCrash: {
    /** This is the id of the worker that exited. */
    workerId: number
    /** These are the indexes that the worker held. */
    indexNames: string[]
    /** This is the error that ended the worker. */
    error: Error
  }
  /** An index gained worker copies, either because it reached the copy
   * threshold or because a request loaded its copies again after an idle
   * spell. */
  workerPromote: {
    /** This is the number of workers in the pool. */
    workerCount: number
    /** This is the reason that the index gained its copies, such as the copy
     * threshold that it reached. */
    reason: string
  }
  /** An index could not gain worker copies, so the main thread keeps serving
   * its queries. */
  workerPromoteFailure: {
    /** This is the reason that the engine tried to load the copies. */
    reason: string
    /** This is the error that stopped the load. */
    error: Error
    /** This is true when the engine will try again at a later threshold. */
    retryable: boolean
  }
  /** An index finished spreading its documents across a new number of
   * partitions. */
  partitionRebalance: {
    /** This is the name of the index that the engine rebalanced. */
    indexName: string
    /** This is the number of partitions before the rebalance. */
    oldCount: number
    /** This is the number of partitions after the rebalance. */
    newCount: number
  }
  /**
   * An index passed its watermark, so its partitions are close to their
   * capacity. On a cluster node, the engine reports the document count and the
   * capacity of the one partition that `partitionId` identifies, which this
   * node leads.
   */
  partitionWatermark: {
    /** This is the name of the index that crossed the mark. */
    indexName: string
    /** This is the number of documents in the index, or in the partition on a
     * cluster node. */
    documentCount: number
    /** This is the number of documents that the current partitions of the
     * index can hold, or that the partition can hold on a cluster node. */
    capacity: number
    /** This is the number of partitions in the index. */
    partitionCount: number
    /** On a cluster node, this is the partition that crossed the mark, while
     * outside a cluster the field is absent. */
    partitionId?: number
  }
  /**
   * The process uses nine tenths of its heap, as measured during a write or a
   * load, so the next large index can end the process with an out-of-memory
   * error.
   *
   * Where `--max-old-space-size` or `--max-old-space-size-percentage` sets a
   * limit, on the command line or in `NODE_OPTIONS`, the engine measures the
   * used bytes against that limit, which `heapLimit` then reports. Where
   * neither flag sets a limit, the engine measures the share of the heap that
   * V8 reports as no longer available. V8 reports a limit about 192 MB above
   * the true ceiling, so a process on a default heap below about 2 GB can end before
   * this event fires.
   *
   * The engine emits the event once per crossing, then arms it again once the
   * free share of the heap recovers to two tenths. Raise the limit with
   * `--max-old-space-size-percentage` or `--max-old-space-size`, or close an
   * idle index; see {@link ProcessMemoryReport.heapLimit}.
   */
  heapPressure: {
    /** This is the index that a write or a load was touching when the heap
     * reached that point. */
    indexName: string
    /** This is the heap that the process uses, in bytes. */
    heapUsed: number
    /** This is the size in bytes that the heap can grow to. */
    heapLimit: number
    /** This is the estimate of the bytes that the index holds. */
    estimatedMemoryBytes: number
  }
  /** The engine started, completed, or failed a rebuild that brings the terms
   * of an index up to the current analysis of its language module. */
  analysisRebuild: {
    /** This is the name of the index under rebuild. */
    indexName: string
    /** This is the stage that the rebuild has reached. */
    status: 'started' | 'completed' | 'failed'
    /** This is the number of partitions that the rebuild has covered so far. */
    partitionsRebuilt: number
    /** This is the number of partitions that the rebuild covers in total. */
    partitionCount: number
    /** This is the error that stopped the rebuild, which only a `failed`
     * status includes. */
    error?: Error
  }
  /** A write to the write-ahead log or a checkpoint failed, so the writes since
   * the last checkpoint are at risk. */
  durabilityError: {
    /** This is the error that the durability layer threw. */
    error: Error
  }
  /** The invalidation channel failed, so this instance can serve partitions
   * that another instance has since changed. */
  invalidationError: {
    /** This is the error that the adapter threw. */
    error: Error
  }
}
