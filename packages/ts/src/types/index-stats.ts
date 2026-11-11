import type { SchemaDefinition } from './schema'

/**
 * What {@link Narsil.getStats} returns about one index.
 *
 * @public
 */
export interface IndexStats {
  /** The index holds this many documents. A closed index reports its count as of the last checkpoint. */
  documentCount: number
  /** The index is spread across this many partitions. */
  partitionCount: number
  /**
   * Formula-based estimate of the index's main-thread memory footprint, summed
   * across every partition and vector index for this index. Computed from
   * structural counters (document count, posting counts, field-index sizes),
   * not measured. Per-object V8 overhead (hidden classes, map transitions,
   * GC headers) is not captured here, so this number routinely undershoots
   * the real heap by a meaningful factor. Use {@link Narsil.getMemoryStats}
   * when sizing host memory.
   */
  estimatedMemoryBytes: number
  /**
   * The files that the index's current checkpoint lists hold this many bytes:
   * the segment files of every partition, the vector files, and the graph
   * parts. The figure changes only when a checkpoint commits, so an unchanged
   * index reports the same size before and after a restart. A closed index
   * reports the size that its last checkpoint recorded, and an index that
   * saves nothing reports no figure. In a cluster, the figure covers the copy
   * of each partition that the stats call read.
   */
  savedBytes?: number
  /**
   * The index's write-ahead log and the history that it keeps for device sync
   * hold this many bytes. The figure grows with every write, and it falls when
   * the engine deletes log or history files. A closed index reports no figure,
   * and neither does an index that saves nothing.
   */
  logBytes?: number
  /**
   * A cluster adds up {@link IndexStats.savedBytes} over every copy of every
   * partition, which shows the disk space that the index takes across all of
   * its nodes. The figure is absent outside a cluster, and it is absent
   * whenever a copy fails to answer or reports no saved size.
   */
  savedBytesOfEveryCopy?: number
  /**
   * A cluster adds up {@link IndexStats.logBytes} over every copy of every
   * partition. The figure is absent outside a cluster, and it is absent
   * whenever a copy fails to answer or reports no log size.
   */
  logBytesOfEveryCopy?: number
  /** The index analyses text with this language module. */
  language: string
  /** The index was created with this field layout. */
  schema: SchemaDefinition
  /**
   * This many searches on this instance's main copy hold a state of the index
   * open right now. Each search holds one state from its start until it
   * answers, fails, or is cancelled, so the figure falls back to 0 once every
   * search has finished. A cluster reports no figure.
   */
  heldSearchStates?: number
}

/**
 * A summary of one index, as {@link Narsil.listIndexes} reports it.
 *
 * @public
 */
export interface IndexInfo {
  /** The index was created under this name. */
  name: string
  /** The index holds this many documents. A closed index reports its count as of the last checkpoint. */
  documentCount: number
  /** The index is spread across this many partitions. */
  partitionCount: number
  /** The index analyses text with this language module. */
  language: string
  /** This turns true when the index's terms came from an older analysis than its language module produces now. */
  analysisStale?: boolean
  /** This is `open` in memory, `closed` after release, and `reopen-failed` after five recovery failures. */
  state: 'open' | 'closed' | 'reopen-failed'
  /** This counts successful loads since this engine started. */
  reopenCount: number
}

/**
 * What {@link Narsil.getPartitionStats} reports for one partition, which is
 * where you look when an index grows unevenly.
 *
 * @public
 */
export interface PartitionStatsResult {
  /** This identifies the partition within its index. */
  partitionId: number
  /** The partition holds this many documents. */
  documentCount: number
  /**
   * Formula-based estimate of this partition's memory footprint. V8 has no
   * per-object heap accounting API, so this number is derived from structural
   * counters (document count, posting counts, field-index sizes) and does not
   * include per-object overhead. Treat as an estimate, not a measurement.
   */
  estimatedMemoryBytes: number
  /**
   * The segment files that the index's current checkpoint lists for this
   * partition hold this many bytes. The vector files and graph parts belong to
   * the whole index, so only {@link IndexStats.savedBytes} counts them.
   */
  savedBytes?: number
  /** This partition's write-ahead log files and device-sync history files hold this many bytes. */
  logBytes?: number
  /**
   * A cluster adds up {@link PartitionStatsResult.savedBytes} over every copy
   * of this partition. The figure is absent outside a cluster, and it is
   * absent whenever a copy fails to answer or reports no saved size.
   */
  savedBytesOfEveryCopy?: number
  /**
   * A cluster adds up {@link PartitionStatsResult.logBytes} over every copy of
   * this partition. The figure is absent outside a cluster, and it is absent
   * whenever a copy fails to answer or reports no log size.
   */
  logBytesOfEveryCopy?: number
}
