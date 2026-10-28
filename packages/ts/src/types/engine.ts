import type { AdapterRegistrationOperations } from './adapter-registration'
import type { NarsilEventMap } from './events'
import type { IndexLifecycleOperations } from './lifecycle'
import type { MemoryStats } from './memory'
import type {
  DocumentImportResult,
  IndexInfo,
  IndexStats,
  ListResult,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
  VectorMaintenanceResult,
} from './results'
import type { AnyDocument, IndexConfig, PartitionConfig } from './schema'
import type { ListParams, QueryParams, SuggestParams } from './search'
import type { DocumentWriteOperations } from './writes'

/**
 * The bytes that {@link Narsil.restore} and {@link Narsil.importDocumentExport}
 * accept, as one array, a stream of chunks, or an async iterable of chunks,
 * such as a Node.js file stream.
 *
 * @public
 */
export type ByteSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

/**
 * The search engine, and everything you do with it.
 *
 * One instance holds every index you create, so an application usually keeps a
 * single engine for its lifetime and reaches each index by name. Build one
 * with {@link createNarsil}. The write methods come from
 * {@link DocumentWriteOperations} and the open and close methods from
 * {@link IndexLifecycleOperations}.
 *
 * @public
 */
export interface Narsil extends IndexLifecycleOperations, DocumentWriteOperations, AdapterRegistrationOperations {
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
   * @returns One entry per open partition, in partition order, or an empty list while the index is closed.
   */
  getPartitionStats(indexName: string): PartitionStatsResult[]
  /**
   * Fetches one stored document by id, without searching.
   *
   * A vector field comes back as a `Float32Array`, whatever form you give it.
   * `JSON.stringify` writes one as an object keyed by index, so convert it
   * with `Array.from`, or project the field away, before you serialise the
   * document yourself. The HTTP routes convert it for you.
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
   * Counts what a query would match without building a single hit, which is
   * how a result-count badge stays cheap. A full-text count also skips scoring
   * unless the query carries `minScore`, which prunes matches by score, or a
   * `termMatch` policy other than `any`, which prunes them by term coverage. A
   * vector or hybrid count still runs its search.
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
   * Returns a stream of the index's snapshot archive. The archive is a pax
   * file containing the index's configuration and the files of one
   * checkpoint, and any implementation of the Narsil format can restore it.
   *
   * With write-ahead log durability, the engine takes a checkpoint before it
   * starts the stream, so the archive contains every write that the engine
   * acknowledged before the call. The engine keeps that checkpoint's files on
   * disk until the stream ends or you cancel it. Without write-ahead log
   * durability, the engine builds the archive's files from the index in
   * memory.
   *
   * @param indexName - The index to stream.
   * @returns A stream of the archive's bytes, which you can write to a file or
   * send over a network.
   */
  snapshot(indexName: string): Promise<ReadableStream<Uint8Array>>
  /**
   * Creates an index from a snapshot under the name that you pass, replacing
   * any index of that name.
   *
   * The engine accepts the archive that {@link Narsil.snapshot} streams. It
   * also accepts the single `.nrsl` file that `snapshot` returned in release
   * 0.3, and it inserts that file's documents and vectors as new writes. The
   * engine reads an archive one file at a time. Before it replaces an existing
   * index, it checks each file against the archive's manifest and decodes
   * every document, so a failed check leaves the existing index unchanged.
   *
   * @param indexName - The name that the restored index takes.
   * @param data - The snapshot's bytes, as one array, a stream, or an async
   * iterable of chunks.
   * @throws A `NarsilError` with `PERSISTENCE_LOAD_FAILED` when the archive is
   * malformed or a file's length differs from the manifest. The engine raises
   * `PERSISTENCE_CRC_MISMATCH` when a file's checksum differs from its
   * contents, and `ENVELOPE_VERSION_MISMATCH` when a file has a format version
   * other than the ones that this release implements. It raises
   * `CONFIG_INVALID` when the archive's configuration is invalid, and
   * `DOC_VALIDATION_FAILED` when the data is empty or the release 0.3 file is
   * invalid.
   */
  restore(indexName: string, data: ByteSource): Promise<void>
  /**
   * Returns a stream of the index's document export. The export is JSON Lines
   * text whose format stays the same in every release, so you can use it to
   * move an index across releases or between implementations.
   *
   * The first line is a header containing the format name, the format
   * version, and the index configuration. Each later line contains one
   * document, with its ID under `id` and the value of each vector field as an
   * array of numbers. With write-ahead log durability, the engine exports every
   * document from one checkpoint; otherwise, it exports them from the index in
   * memory at one moment.
   *
   * JSON has no type for a date, for raw bytes, or for an infinite number or
   * `NaN`, so the engine writes each such value as a tag. Each tag is an
   * object with one key that begins with `$`, such as
   * `{"$date":[1700000000,123000000]}`. The engine also wraps a stored object
   * whose only key begins with `$` in an `$object` tag, because the import
   * decodes every other object of that shape as a tag.
   *
   * @param indexName - The index to export.
   * @returns A stream of the export's UTF-8 bytes.
   */
  exportDocuments(indexName: string): Promise<ReadableStream<Uint8Array>>
  /**
   * Imports a document export into the named index. Where the name is free,
   * the engine creates the index from the export's configuration.
   *
   * The engine writes the documents in batches and replaces any document
   * whose ID the index already contains. Because it replaces existing
   * documents, you can run an interrupted import again to make the index equal
   * to the export. When a line is invalid or the engine rejects its document,
   * the engine records the refusal and continues with the next line.
   *
   * The engine converts each tag that {@link Narsil.exportDocuments} writes
   * into the value that the tag stands for. When an object has one key that
   * begins with `$` and that key names no tag, or when a tag holds an invalid
   * value, the engine refuses the line.
   *
   * @param indexName - The index that receives the documents.
   * @param data - The export's bytes, as one array, a stream, or an async
   * iterable of chunks.
   * @returns The number of imported documents, the number of refused lines,
   * and the 1,000 refusals with the lowest line numbers.
   * @throws A `NarsilError` with `CONFIG_INVALID` when the first line is
   * anything other than a version 1 header, or when the named index exists
   * with a different schema.
   */
  importDocumentExport(indexName: string, data: ByteSource): Promise<DocumentImportResult>
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
   * @returns One entry per vector field, or an empty list while the index is closed.
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
