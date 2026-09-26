import type { QueryResult } from './results'
import type { AnyDocument, IndexConfig } from './schema'
import type { QueryParams } from './search'

/**
 * Hooks that the engine calls alongside its own work, so that an application
 * can add validation, auditing, enrichment, or metrics without forking the
 * engine.
 *
 * Every hook is optional. A `before` hook fires first and rejects the
 * operation by throwing, while an `after` hook fires once the operation
 * succeeds. Where a `before` hook on a write throws a {@link NarsilError}, the
 * engine passes that error to the caller unchanged. It turns any other error
 * into `DOC_VALIDATION_FAILED` with the same message, for a single write and
 * for each entry of a batch alike. The engine awaits a hook that returns a
 * promise, so slow work in one hook slows every write or search that it
 * covers.
 *
 * @public
 */
export interface NarsilPlugin {
  /** This name identifies the plugin in errors and in event payloads. */
  name: string
  /** Fires before the engine indexes a document. Throw to reject the write. */
  beforeInsert?(ctx: InsertContext): void | Promise<void>
  /** Fires once the engine has indexed a document. */
  afterInsert?(ctx: InsertContext): void | Promise<void>
  /** Fires before the engine removes a document. Throw to reject the removal. */
  beforeRemove?(ctx: RemoveContext): void | Promise<void>
  /** Fires once the engine has removed a document. */
  afterRemove?(ctx: RemoveContext): void | Promise<void>
  /** Fires before the engine replaces a document. Throw to reject the update. */
  beforeUpdate?(ctx: UpdateContext): void | Promise<void>
  /** Fires once the engine has replaced a document. */
  afterUpdate?(ctx: UpdateContext): void | Promise<void>
  /**
   * Fires before every search, and before every preflight. Throw to reject the
   * query. It fires before the engine embeds a `vector.text` query, so a hook
   * that counts or refuses work stops the call to the embedding provider, and
   * `ctx.params.vector` still holds the text that the caller passed.
   * {@link Narsil.suggest} scans the term dictionary and searches no document,
   * so it fires no hook.
   */
  beforeSearch?(ctx: SearchContext): void | Promise<void>
  /**
   * Fires once a search returns. The context holds a copy of the results, so a
   * change that you make here leaves the caller's own result untouched. Where
   * this hook throws, the engine logs a warning and answers the query all the
   * same, because the search is already over.
   */
  afterSearch?(ctx: SearchContext): void | Promise<void>
  /**
   * Fires once the engine creates an index, and a `restore` fires it too,
   * because a restore recreates the index that it replaces. Where this hook
   * throws, the engine logs a warning and keeps the index, because the hook
   * fires after the index exists.
   */
  onIndexCreate?(ctx: IndexContext): void | Promise<void>
  /**
   * Fires once the engine drops an index, and a `restore` fires it too,
   * because a restore drops the index that it replaces. Where this hook
   * throws, the engine logs a warning, because the hook fires after the index
   * is gone.
   */
  onIndexDrop?(ctx: IndexContext): void | Promise<void>
  /**
   * Fires once {@link Narsil.rebalance} moves an index onto a new partition
   * count, which is the only way that the count changes. An index opens with
   * the count that `partitions.maxPartitions` sets, because the engine adds no
   * partition on its own. Subscribe to the `partitionWatermark` event to learn
   * when an index fills its capacity.
   */
  onPartitionSplit?(ctx: PartitionContext): void | Promise<void>
  /** Fires once the engine loads worker copies of its indexes. */
  onWorkerPromote?(ctx: WorkerContext): void | Promise<void>
}

/**
 * What a plugin receives around an insert.
 *
 * @public
 */
export interface InsertContext {
  /** The engine writes the document to this index. */
  indexName: string
  /** The document is stored under this id, which the engine resolves before the `before` hook runs. */
  docId: string
  /** This is the document itself, and the engine indexes whatever a `before` hook leaves here. */
  document: AnyDocument
}

/**
 * What a plugin receives around a removal.
 *
 * @public
 */
export interface RemoveContext {
  /** The engine removes the document from this index. */
  indexName: string
  /** The engine removes this document. */
  docId: string
}

/**
 * What a plugin receives around an update.
 *
 * @public
 */
export interface UpdateContext {
  /** The document belongs to this index. */
  indexName: string
  /** The engine replaces this document. */
  docId: string
  /** The index holds this document before the update. */
  oldDocument: AnyDocument
  /** This document replaces it, and the engine indexes whatever a `before` hook leaves here. */
  newDocument: AnyDocument
}

/**
 * What a plugin receives around a search.
 *
 * @public
 */
export interface SearchContext {
  /** The search runs against this index. */
  indexName: string
  /** These are the parameters the query runs with, and a `before` hook that changes them rewrites the search. */
  params: QueryParams
  /**
   * These are the results, which an `after` hook alone receives. A preflight
   * fires `beforeSearch` and stops there, because it answers with a count and
   * no hits. Read this field inside an `afterSearch` hook alone.
   */
  results?: QueryResult
}

/**
 * What a plugin receives when the engine creates or drops an index.
 *
 * @public
 */
export interface IndexContext {
  /** The engine creates or drops this index. */
  indexName: string
  /** The index holds this configuration. */
  config: IndexConfig
}

/**
 * What a plugin receives when a rebalance changes an index's partition count.
 *
 * @public
 */
export interface PartitionContext {
  /** The rebalance moved this index. */
  indexName: string
  /** The index held this many partitions before the rebalance. */
  oldPartitionCount: number
  /** The index holds this many partitions now. */
  newPartitionCount: number
}

/**
 * What a plugin receives when the engine moves onto worker threads.
 *
 * @public
 */
export interface WorkerContext {
  /** The pool holds this many workers. */
  workerCount: number
  /** The engine promoted for this reason, such as the threshold that the index crossed. */
  reason: string
}
