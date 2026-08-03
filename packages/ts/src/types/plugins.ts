import type { QueryResult } from './results'
import type { AnyDocument, IndexConfig } from './schema'
import type { QueryParams } from './search'

/**
 * Hooks that run alongside the engine's own work, which is how you add
 * validation, auditing, enrichment, or metrics without forking the engine.
 *
 * Every hook is optional. A `before` hook runs first and rejects the operation
 * by throwing; an `after` hook runs once the operation succeeds. The engine
 * awaits a hook that returns a promise, so slow work in one slows every write
 * or search it covers.
 *
 * @public
 */
export interface NarsilPlugin {
  /** This name identifies the plugin in errors and in event payloads. */
  name: string
  /** Runs before a document is indexed. Throw to reject the write. */
  beforeInsert?(ctx: InsertContext): void | Promise<void>
  /** Runs once a document is indexed. */
  afterInsert?(ctx: InsertContext): void | Promise<void>
  /** Runs before a document is removed. Throw to reject the removal. */
  beforeRemove?(ctx: RemoveContext): void | Promise<void>
  /** Runs once a document is removed. */
  afterRemove?(ctx: RemoveContext): void | Promise<void>
  /** Runs before a document is replaced. Throw to reject the update. */
  beforeUpdate?(ctx: UpdateContext): void | Promise<void>
  /** Runs once a document is replaced. */
  afterUpdate?(ctx: UpdateContext): void | Promise<void>
  /** Runs before a search executes. Throw to reject the query. */
  beforeSearch?(ctx: SearchContext): void | Promise<void>
  /** Runs once a search returns, with the results on the context. */
  afterSearch?(ctx: SearchContext): void | Promise<void>
  /** Runs once an index is created. */
  onIndexCreate?(ctx: IndexContext): void | Promise<void>
  /** Runs once an index is dropped. */
  onIndexDrop?(ctx: IndexContext): void | Promise<void>
  /** Runs once an index grows into another partition. */
  onPartitionSplit?(ctx: PartitionContext): void | Promise<void>
  /** Runs once the engine moves its indexes onto worker threads. */
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
  /** This is the document itself, and a `before` hook that changes it decides what the engine indexes. */
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
  /** This document is being removed. */
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
  /** This document is being replaced. */
  docId: string
  /** The index stored this document before the update. */
  oldDocument: AnyDocument
  /** This document replaces it, and a `before` hook that changes it decides what the engine indexes. */
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
  /** These are the results, which an `after` hook alone receives. */
  results?: QueryResult
}

/**
 * What a plugin receives when an index is created or dropped.
 *
 * @public
 */
export interface IndexContext {
  /** This index is being created or dropped. */
  indexName: string
  /** The index was created with this configuration. */
  config: IndexConfig
}

/**
 * What a plugin receives when an index grows into another partition.
 *
 * @public
 */
export interface PartitionContext {
  /** This index grew. */
  indexName: string
  /** The index held this many partitions before. */
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
  /** The pool started with this many workers. */
  workerCount: number
  /** The engine promoted for this reason, such as the threshold the index passed. */
  reason: string
}
