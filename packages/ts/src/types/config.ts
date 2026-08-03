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
  /** These settings decide when the engine moves its indexes onto worker threads, and how many it uses. */
  workers?: WorkerConfig
  /** Every index uses this adapter unless its own config names another. */
  embedding?: EmbeddingAdapter
  /** Named adapters; names persist in index metadata so recovery can rebind. */
  embeddingAdapters?: Record<string, EmbeddingAdapter>
  /** These settings recover the writes made since the last snapshot. */
  durability?: DurabilityConfig
  /** These settings decide what the engine does when an index's stored analysis no longer matches its language module. */
  analysis?: AnalysisConfig
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
 * decides whether the engine starts that work itself.
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
 * When the engine moves its indexes onto worker threads, and how many it uses.
 *
 * An engine starts on the main thread, where a small index answers fastest.
 * Once an index passes a threshold the engine promotes it to a worker pool, so
 * that indexing and searching run off the calling thread.
 *
 * @public
 */
export interface WorkerConfig {
  /** Setting this allows promotion to worker threads. The engine promotes nothing while it is false. */
  enabled?: boolean
  /** The pool runs this many workers. The engine derives a count from the host's cores by default. */
  count?: number
  /** This many documents in one index trigger promotion. */
  promotionThreshold?: number
  /** This many documents across every index trigger promotion. */
  totalPromotionThreshold?: number
  /** Each worker imports this module on start-up, which is how a worker reaches a custom tokeniser or language. */
  bootstrapModule?: string
}
