/**
 * Every event the engine emits, with the payload each one carries.
 *
 * {@link Narsil.on} takes a key from this map and hands your listener the
 * matching payload. These events report work the engine does on its own, away
 * from the call that triggered it, so a failure here never rejects a promise
 * you are holding.
 *
 * @public
 */
export type NarsilEventMap = {
  /**
   * A worker thread died. The pool drops it and fails its outstanding requests
   * with `WORKER_CRASHED`, while the remaining workers keep answering because
   * each holds a full worker copy of every promoted index. Once no worker is
   * left, queries fall back to the main thread, which holds every document.
   */
  workerCrash: {
    /** This worker died. */
    workerId: number
    /** That worker was holding these indexes. */
    indexNames: string[]
    /** This ended the worker. */
    error: Error
  }
  /** The engine moved its indexes onto worker threads. */
  workerPromote: {
    /** The pool started with this many workers. */
    workerCount: number
    /** The engine promoted for this reason, such as the threshold the index passed. */
    reason: string
  }
  /** The engine tried to move onto worker threads and could not. Indexes keep answering on the main thread. */
  workerPromoteFailure: {
    /** The engine tried to promote for this reason. */
    reason: string
    /** This stopped it. */
    error: Error
    /** This turns true when the engine will try again on a later threshold. */
    retryable: boolean
  }
  /** An index finished spreading its documents across a new partition count. */
  partitionRebalance: {
    /** This index was rebalanced. */
    indexName: string
    /** The index held this many partitions before. */
    oldCount: number
    /** The index holds this many partitions now. */
    newCount: number
  }
  /** A partition passed its watermark, so the index is close to needing another one. */
  partitionWatermark: {
    /** This index crossed the mark. */
    indexName: string
    /** The index holds this many documents. */
    documentCount: number
    /** The index can hold this many across its current partitions. */
    capacity: number
    /** The index holds this many partitions. */
    partitionCount: number
  }
  /** A rebuild is bringing an index's terms up to its language module's current analysis. */
  analysisRebuild: {
    /** This index is being rebuilt. */
    indexName: string
    /** The rebuild stands here. */
    status: 'started' | 'completed' | 'failed'
    /** The rebuild has covered this many partitions so far. */
    partitionsRebuilt: number
    /** The rebuild covers this many partitions in total. */
    partitionCount: number
    /** This stopped the rebuild, and only a `failed` status carries it. */
    error?: Error
  }
  /** The write-ahead log or a checkpoint failed, so writes since the last checkpoint are at risk. */
  durabilityError: {
    /** The durability layer threw this. */
    error: Error
  }
  /** The invalidation channel failed, so this instance may be reading partitions another instance has changed. */
  invalidationError: {
    /** The adapter threw this. */
    error: Error
  }
}
