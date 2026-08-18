import type { EmbeddingAdapter } from './adapters'
import type { NarsilEventMap } from './events'
import type {
  BatchResult,
  IndexInfo,
  IndexStats,
  ListResult,
  MemoryStats,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
  VectorMaintenanceResult,
} from './results'
import type { AnyDocument, IndexConfig, InsertOptions, PartitionConfig } from './schema'
import type { ListParams, QueryParams, SuggestParams } from './search'

/**
 * The search engine, and everything you do with it.
 *
 * One instance holds every index you create, so an application usually keeps a
 * single engine for its lifetime and reaches each index by name. Build one
 * with {@link createNarsil}.
 *
 * @public
 */
export interface Narsil {
  /**
   * Creates an index you can insert documents into and query.
   *
   * The schema sets the type of each field, marks which fields you can
   * filter and sort on, and controls how the engine tokenises text. The
   * `language` option picks the analyser that stems those text fields.
   *
   * @param name - Every later call uses this name to reach the index.
   * @param config - This carries the schema, and the language, partitioning,
   * and scoring settings.
   */
  createIndex(name: string, config: IndexConfig): Promise<void>
  /** Registers an adapter under a name that index configs can reference and
   * durability metadata can persist; re-registering rebinds referencing indexes. */
  registerEmbeddingAdapter(name: string, adapter: EmbeddingAdapter): void
  /**
   * Removes an index and everything it holds, including whatever persistence
   * wrote for it. The documents do not come back.
   *
   * @param name - The index to drop.
   */
  dropIndex(name: string): Promise<void>
  /**
   * Lists every index this engine holds, with its size and its language.
   *
   * @returns One entry per index, in creation order.
   */
  listIndexes(): IndexInfo[]
  /**
   * Returns one index's document count, partition count, memory estimate,
   * language, and schema.
   *
   * @param indexName - The index to describe.
   * @returns The index's current figures.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` for an unknown name.
   */
  getStats(indexName: string): IndexStats
  /**
   * Returns per-partition figures for one index, which is where you look when
   * an index grows unevenly or a rebalance is worth running.
   *
   * @param indexName - The index to describe.
   * @returns One entry per partition, in partition order.
   */
  getPartitionStats(indexName: string): PartitionStatsResult[]
  /**
   * Adds one document to an index and returns the id it is stored under.
   *
   * The id comes from the `docId` argument when you pass one, otherwise from
   * the document's own `id` field, and otherwise the engine generates it. Use
   * {@link Narsil.insertBatch} for a large load, so that one bad document
   * cannot abandon the rest.
   *
   * @param indexName - The index that receives the document.
   * @param document - Its fields must match the types the schema declares.
   * @param docId - Pass an id to control it yourself, or omit it and read the
   * returned value.
   * @param options - Per-write settings, such as skipping the defensive copy.
   * @returns The id the document is stored under.
   */
  insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string>
  /**
   * Adds many documents in one pass and reports each one's outcome.
   *
   * A document the engine rejects appears in `failed` with the error that
   * rejected it, and every other document is still written, which is what
   * makes this the call to load a corpus with.
   *
   * @param indexName - The index that receives the documents.
   * @param documents - The documents to write, each carrying its own id or
   * leaving the engine to generate one.
   * @param options - Per-write settings applied to every document.
   * @returns The ids written, and each rejection with its error.
   */
  insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult>
  /**
   * Removes one document.
   *
   * @param indexName - The index holding the document.
   * @param docId - The document to remove.
   * @throws A `NarsilError` with `DOC_NOT_FOUND` when the index holds no such
   * document.
   */
  remove(indexName: string, docId: string): Promise<void>
  /**
   * Removes many documents in one pass and reports each one's outcome.
   *
   * @param indexName - The index holding the documents.
   * @param docIds - The documents to remove.
   * @returns The ids removed, and each failure with its error.
   */
  removeBatch(indexName: string, docIds: string[]): Promise<BatchResult>
  /**
   * Replaces a stored document with the one you pass.
   *
   * The engine removes the old document and indexes the new one, so the
   * document you supply has to be complete rather than a set of changed
   * fields.
   *
   * @param indexName - The index holding the document.
   * @param docId - The document to replace.
   * @param document - The complete replacement.
   */
  update(indexName: string, docId: string, document: AnyDocument): Promise<void>
  /**
   * Replaces many documents in one pass and reports each one's outcome.
   *
   * @param indexName - The index holding the documents.
   * @param updates - Each id with the complete document that replaces it.
   * @returns The ids replaced, and each failure with its error.
   */
  updateBatch(indexName: string, updates: Array<{ docId: string; document: AnyDocument }>): Promise<BatchResult>
  /**
   * Fetches one stored document by id, without searching.
   *
   * @param indexName - The index holding the document.
   * @param docId - The document to fetch.
   * @returns The document, or `undefined` when the index holds no such id.
   */
  get(indexName: string, docId: string): Promise<AnyDocument | undefined>
  /**
   * Fetches many stored documents by id in one pass.
   *
   * @param indexName - The index holding the documents.
   * @param docIds - The documents to fetch.
   * @returns A map from id to document, holding an entry for each id that
   * exists and nothing for the rest.
   */
  getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>>
  /**
   * Reports whether an index holds a document, without reading it.
   *
   * @param indexName - The index to check.
   * @param docId - The document to look for.
   * @returns True when the index holds that id.
   */
  has(indexName: string, docId: string): Promise<boolean>
  /**
   * Counts the documents an index holds.
   *
   * @param indexName - The index to count.
   * @returns The document count across every partition.
   */
  countDocuments(indexName: string): Promise<number>
  /**
   * Reads one page of stored documents in document-id order, without
   * searching, which is how you page through a whole index.
   *
   * Leave `cursor` out for the first page, pass the returned cursor back for
   * each page after it, and stop when the cursor comes back null. A document
   * that stays in the index for the whole listing comes back exactly once. The
   * engine skips a document you remove part-way through. It returns one you
   * insert part-way through once that document's id sorts above the cursor.
   * The cursor holds no engine state, so it stays valid after a restart, a
   * snapshot restore, and a rebalance.
   *
   * The engine compares document ids by their UTF-16 code units, so `"10"`
   * sorts ahead of `"9"`.
   *
   * Set `document` to drop a vector field, because the engine otherwise reads
   * every listed document's vector back out of the index.
   *
   * @typeParam T - Shape of the stored documents, which flows through to each
   * entry's `document`.
   * @param indexName - The index to walk.
   * @param params - These set the cursor, the page size, the filter, and how
   * much of each document comes back.
   * @returns The page, the cursor for the next page, how many documents the
   * listing walks in total, and the time the page took.
   */
  listDocuments<T = AnyDocument>(indexName: string, params?: ListParams): Promise<ListResult<T>>
  /**
   * Runs a search against an index and returns the ranked hits.
   *
   * One call covers keyword search, vector search, and a hybrid of the two,
   * chosen by the `mode` parameter. BM25 ranks keyword results by default.
   * Every hit carries its score and its document, along with highlights when
   * you ask for them.
   *
   * @typeParam T - Shape of the stored documents, which flows through to each
   * hit's `document`.
   * @param indexName - The index the search runs against.
   * @param params - These set the search term, filters, field boosts, sorting,
   * facets, highlighting, and the result limit.
   * @returns The hits, the total count, the elapsed time, and any facets or
   * groups the query asked for.
   */
  query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>>
  /**
   * Counts what a query would match without building or ranking a single hit,
   * which is how a result-count badge stays cheap.
   *
   * @param indexName - The index the query would run against.
   * @param params - The same parameters {@link Narsil.query} takes. Anything
   * that shapes the output alone, such as `limit` or `highlight`, is ignored.
   * @returns The match count and the time the count took.
   */
  preflight(indexName: string, params: QueryParams): Promise<PreflightResult>
  /**
   * Returns the indexed terms that complete a prefix, ready to offer as
   * you-type suggestions.
   *
   * The terms come back as the index holds them, which means stems unless the
   * index was created with `surfaceForms`.
   *
   * @param indexName - The index to draw completions from.
   * @param params - The prefix typed so far, and how many completions to
   * return.
   * @returns The completions, most widely used first.
   */
  suggest(indexName: string, params: SuggestParams): Promise<SuggestResult>
  /**
   * Rebuilds an index's terms from the documents it already stores, and
   * resolves once every partition carries terms the current language module
   * produced.
   *
   * An index whose stored analysis revision differs from the one its language
   * module carries answers text queries from terms an earlier analysis wrote,
   * and every such result reports `analysisStale`. Call this after the engine
   * reports a stale index to configuration that declined an automatic rebuild.
   * Calling it for an index whose terms are current does nothing.
   *
   * @param indexName - The index whose terms are rebuilt.
   */
  rebuildAnalysis(indexName: string): Promise<void>
  /**
   * Serialises a whole index into the portable `.nrsl` format, which any
   * Narsil implementation reads.
   *
   * @param indexName - The index to serialise.
   * @returns The file's bytes, ready to store or send.
   */
  snapshot(indexName: string): Promise<Uint8Array>
  /**
   * Loads an index from `.nrsl` bytes, replacing whatever the name held.
   *
   * @param indexName - The name the restored index takes.
   * @param data - Bytes a {@link Narsil.snapshot} produced.
   * @throws A `NarsilError` with `ENVELOPE_INVALID_MAGIC` or
   * `ENVELOPE_VERSION_MISMATCH` when the bytes are not a file this engine
   * reads.
   */
  restore(indexName: string, data: Uint8Array): Promise<void>
  /**
   * Writes an index's current state to the durability directory, so a restart
   * replays less of the log.
   *
   * @param indexName - The index to checkpoint.
   */
  checkpoint(indexName: string): Promise<void>
  /**
   * Removes every document from an index and keeps the index itself, along
   * with its schema and settings.
   *
   * @param indexName - The index to empty.
   */
  clear(indexName: string): Promise<void>
  /**
   * Spreads an index's documents across a different number of partitions.
   *
   * The engine keeps answering queries throughout, and it queues the writes
   * that arrive while the work runs, replaying them in order once it finishes.
   *
   * @param indexName - The index to rebalance.
   * @param targetPartitionCount - Partitions the index ends up with.
   */
  rebalance(indexName: string, targetPartitionCount: number): Promise<void>
  /**
   * Changes how an index grows into new partitions, without moving the
   * documents it already holds.
   *
   * @param indexName - The index to reconfigure.
   * @param config - The partitioning fields to change. Anything you leave out
   * keeps its current value.
   */
  updatePartitionConfig(indexName: string, config: Partial<PartitionConfig>): Promise<void>
  /**
   * Reports what this engine and its host process are using, which is what you
   * size a host from.
   *
   * @returns Process heap figures, the engine's own estimate, and one entry
   * per worker once the engine has promoted.
   */
  getMemoryStats(): Promise<MemoryStats>
  /**
   * Rebuilds a vector field's graph without the tombstones removed documents
   * left behind, which returns the memory they held and speeds searches up.
   *
   * Read {@link Narsil.vectorMaintenanceStatus} first to see whether the work
   * is worth its cost.
   *
   * @param indexName - The index holding the field.
   * @param fieldName - The vector field to compact. Omit it to compact every
   * vector field in the index.
   */
  compactVectors(indexName: string, fieldName?: string): Promise<void>
  /**
   * Rebuilds a vector field's graph from scratch, which recovers the recall a
   * long run of inserts and removals costs.
   *
   * This is heavier than {@link Narsil.compactVectors} and gives a better
   * graph, so run it once a search starts missing documents it should find,
   * rather than on a schedule.
   *
   * @param indexName - The index holding the field.
   * @param fieldName - The vector field to rebuild. Omit it to rebuild every
   * vector field in the index.
   */
  optimizeVectors(indexName: string, fieldName?: string): Promise<void>
  /**
   * Reports the state of each vector field in an index, and what compaction or
   * optimisation would cost.
   *
   * @param indexName - The index to describe.
   * @returns One entry per vector field.
   */
  vectorMaintenanceStatus(indexName: string): VectorMaintenanceResult[]
  /**
   * Starts delivering one kind of engine event to your listener.
   *
   * These events report work the engine does on its own, away from the call
   * that triggered it, so this is where a failed background save or a worker
   * crash reaches you.
   *
   * @typeParam K - The event name, which fixes the payload the listener gets.
   * @param event - Which event to listen for.
   * @param handler - Called once per event.
   */
  on<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  /**
   * Removes a listener {@link Narsil.on} registered, so it receives no
   * further events.
   *
   * @typeParam K - The event name.
   * @param event - The event the listener was registered for.
   * @param handler - The same function reference that was registered.
   */
  off<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  /**
   * Closes the engine: it flushes pending writes, ends its workers, and
   * releases every adapter it opened.
   *
   * Call it before the process exits, because writes still in flight are lost
   * otherwise. The engine rejects new work once this starts.
   */
  shutdown(): Promise<void>
}
