import type { EmbeddingAdapter, InvalidationAdapter, PersistenceAdapter } from './adapters'
import type { NarsilPlugin } from './plugins'
import type { BM25Params, CustomTokenizer } from './schema'

export type { BM25Params, CustomTokenizer }

/**
 * Everything {@link createNarsil} accepts when it builds an engine.
 *
 * Every field is optional, and an engine created without any of them keeps
 * its indexes in memory alone. Add persistence to survive a restart, add
 * invalidation to share a store with another process, and add durability to
 * recover the writes made since the last snapshot.
 *
 * @public
 */
export interface NarsilConfig {
  /** This adapter writes partitions somewhere they outlive the process. */
  persistence?: PersistenceAdapter
  /** This channel carries partition changes to other instances sharing the store. */
  invalidation?: InvalidationAdapter
  /** These hooks observe or reject writes, searches, and lifecycle changes. */
  plugins?: NarsilPlugin[]
  /** This supplies the id for a document inserted without one. The engine generates a UUID v7 by default. */
  idGenerator?: () => string
  /** These settings control when an index gains worker copies, how many threads they share, and when an idle index gives them up. */
  workers?: WorkerConfig
  /** Every index uses this adapter unless its own config names another. */
  embedding?: EmbeddingAdapter
  /** Named adapters; names persist in index metadata so recovery can rebind. */
  embeddingAdapters?: Record<string, EmbeddingAdapter>
  /** These settings recover the writes made since the last snapshot. */
  durability?: DurabilityConfig
  /** These settings control what the engine does when an index's stored analysis differs from its language module. */
  analysis?: AnalysisConfig
  /** These limits close indexes while keeping their durable files ready to reopen. */
  lifecycle?: IndexLifecycleConfig
}

/**
 * Limits on the indexes one engine keeps open in memory.
 *
 * @public
 */
export interface IndexLifecycleConfig {
  /** An index closes after this many milliseconds without activity. */
  idleTimeoutMs?: number
  /** The engine keeps at most this many indexes open at once. */
  maxOpenIndexes?: number
  /** Open indexes may use at most this many estimated bytes in total. */
  maxOpenBytes?: number
  /** At most this many callers may wait behind one index reopen. */
  maxReopenWaiters?: number
}

/**
 * Describes an index whose stored terms came from an older analysis than the
 * one its language module carries today.
 *
 * The engine hands this to {@link AnalysisConfig.onStaleAnalysis} together
 * with the rebuild that fixes it, so you decide when the work runs.
 *
 * @public
 */
export interface StaleAnalysis {
  /** This index holds terms that are out of date. */
  indexName: string
  /** The index was built with this language module. */
  language: string
  /** The index recorded this revision when it was written, and `null` for an index written before revisions existed. */
  storedRevision: string | null
  /** The language module carries this revision now. */
  currentRevision: string
  /** The rebuild reindexes this many documents. */
  documentCount: number
}

/**
 * What the engine does when an index's stored terms no longer match the
 * analysis its language module produces.
 *
 * A stale index answers text queries from terms an older analysis wrote, and
 * every such result reports `analysisStale`. Rebuilding fixes it, and this
 * setting controls whether the engine starts that work itself.
 *
 * @public
 */
export interface AnalysisConfig {
  /** `auto` rebuilds a stale index in the background, and `manual` leaves it to you. The engine rebuilds automatically by default. */
  rebuild?: 'auto' | 'manual'
  /**
   * Called once for each stale index the engine finds.
   *
   * @param index - The index that is stale, and how far behind it is.
   * @param rebuild - Starts the rebuild and resolves once every partition
   * carries current terms. Under `manual` nothing rebuilds until you call it.
   */
  onStaleAnalysis?(index: StaleAnalysis, rebuild: () => Promise<void>): void | Promise<void>
}

/**
 * Write-ahead logging and checkpointing, which recover the writes made since
 * the last snapshot.
 *
 * The `wal` tier logs every mutation before applying it, so a crash costs
 * nothing once the log replays. The `snapshot` tier writes whole partitions on
 * an interval, which is cheaper to run and loses whatever arrived after the
 * last write.
 *
 * @public
 */
export interface DurabilityConfig {
  /** `wal` logs every mutation, and `snapshot` writes whole partitions on an interval. */
  tier?: 'wal' | 'snapshot'
  /** The engine writes the log and its checkpoints into this directory. */
  directory?: string
  /** `sync` flushes before a write resolves, and `async` flushes on the interval below. */
  mode?: 'sync' | 'async'
  /** In `async` mode the engine flushes this many milliseconds apart. */
  flushIntervalMs?: number
  /** The log rolls over to a new segment once it reaches this size. */
  segmentMaxBytes?: number
  /** The engine checkpoints this many milliseconds apart, which shortens the replay a restart has to do. */
  checkpointIntervalMs?: number
  /** This many mutations trigger a checkpoint before the interval elapses. */
  checkpointMutationThreshold?: number
  /** Compaction reclaims the log once this fraction of it is dead. */
  compactionThreshold?: number
}

/**
 * How the engine holds worker copies of its indexes, and how many threads
 * they may use.
 *
 * A small index answers fastest on the main thread. Once an index holds as
 * many documents as the copy threshold, the engine loads a copy of it onto
 * every worker thread, and each query then runs whole on the copy with the
 * fewest queries in flight. The same switch governs the vector search pool.
 *
 * @public
 */
export interface WorkerConfig {
  /**
   * Whether the engine may hold worker copies and a vector search pool. It is
   * on wherever the runtime has worker threads and off in a browser. Set it to
   * false to hold the process to one thread, which leaves both pools absent.
   */
  enabled?: boolean
  /**
   * The keyword copies and the vector search pool share this many threads
   * between them, half each. The engine takes the host's cores minus one by
   * default, between 2 and 8.
   */
  count?: number
  /** An index gains worker copies once it holds this many documents, 1,000 by default. */
  promotionThreshold?: number
  /**
   * The engine drops an index's copies after this many milliseconds without a
   * read or a write, five minutes by default, and loads them again on the
   * next request while the main copy answers it.
   */
  idleTimeoutMs?: number
  /** Each worker imports this module on start-up, which is how a worker reaches a custom tokeniser or language. */
  bootstrapModule?: string
}
