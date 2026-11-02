import type {
  AnalysisChange,
  AnyDocument,
  BatchResult,
  BM25Params,
  DocumentImportResult,
  DurabilityConfig,
  IndexConfig,
  IndexInfo,
  IndexStats,
  InsertOptions,
  ListParams,
  ListResult,
  MemoryStats,
  NarsilConfig,
  NarsilEventMap,
  PartitionConfig,
  PartitionStatsResult,
  PreflightResult,
  QueryParams,
  QueryResult,
  SuggestParams,
  SuggestResult,
  SynonymRule,
  VectorMaintenanceResult,
  WriteOptions,
} from '@delali/narsil'

/**
 * The engine settings that an app passes from its own JS thread. Each value
 * has to cross to the engine's runtime as data, so the settings that hold a
 * function, such as an embedding adapter or a plugin, go in an
 * {@link EngineSetup} worklet instead.
 *
 * `durability` defaults to a write-ahead log in a `narsil` directory inside
 * the app's private storage, and `null` keeps the index in memory alone. A
 * relative `directory` resolves against that private storage.
 *
 * @public
 */
export type PhoneNarsilConfig = Omit<
  NarsilConfig,
  | 'persistence'
  | 'invalidation'
  | 'plugins'
  | 'idGenerator'
  | 'embedding'
  | 'embeddingAdapters'
  | 'rerankAdapters'
  | 'events'
  | 'durability'
> & { durability?: DurabilityConfig | null }

/**
 * A worklet that runs on the engine's runtime before the engine starts, and
 * returns the settings that hold functions, such as `embeddingAdapters`,
 * `plugins`, or `idGenerator`. Its values override the matching values of
 * {@link PhoneNarsilConfig}. Mark the function with the `'worklet'`
 * directive, and register a language or a tokenizer inside it.
 *
 * @public
 */
export type EngineSetup = () => Partial<NarsilConfig> | Promise<Partial<NarsilConfig>>

/**
 * Receives one engine event on the app's JS thread. An `Error` inside the
 * payload arrives as an `Error` carrying the original `name`, `message`,
 * `code`, and `details`.
 *
 * @public
 */
export type PhoneEventHandler<K extends keyof NarsilEventMap> = (payload: NarsilEventMap[K]) => void

/**
 * A Narsil engine that works on its own Hermes runtime, so a long search or a
 * large import leaves the app's JS thread free. Every method sends one
 * request to that runtime and resolves with the engine's answer. A method
 * that the engine answers synchronously, such as `listIndexes`, also
 * resolves through a promise here. Each method otherwise behaves as the
 * method of the same name on the `Narsil` interface of `@delali/narsil`.
 *
 * A failure rejects with an `Error` whose `name` is `NarsilError` for an
 * engine failure, and whose `code` and `details` match the engine's error.
 * {@link isNarsilError} recognises it.
 *
 * @public
 */
export interface PhoneNarsil {
  /** Creates an index from a schema and its settings. */
  createIndex(name: string, config: IndexConfig): Promise<void>
  /** Removes an index and the files that it wrote. */
  dropIndex(name: string): Promise<void>
  /** Lists every index that this engine holds. */
  listIndexes(): Promise<IndexInfo[]>
  /** Returns one index's document count, memory estimate, and schema. */
  getStats(indexName: string): Promise<IndexStats>
  /** Returns the figures of each open partition of one index. */
  getPartitionStats(indexName: string): Promise<PartitionStatsResult[]>
  /** Fetches one stored document by id, or `undefined` when the index lacks it. */
  get(indexName: string, docId: string): Promise<AnyDocument | undefined>
  /** Fetches many stored documents by id, keyed by id. */
  getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>>
  /** Reports whether an index holds a document. */
  has(indexName: string, docId: string): Promise<boolean>
  /** Counts the documents of one index. */
  countDocuments(indexName: string): Promise<number>
  /** Reads one page of stored documents in document-id order. */
  listDocuments<T = AnyDocument>(indexName: string, params?: ListParams): Promise<ListResult<T>>
  /** Searches one index by keyword, by vector, or by both. */
  query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>>
  /** Counts what a query would match without building a single hit. */
  preflight(indexName: string, params: QueryParams): Promise<PreflightResult>
  /** Returns the indexed terms that complete a prefix. */
  suggest(indexName: string, params: SuggestParams): Promise<SuggestResult>
  /** Rebuilds an index's terms from the documents that it already stores. */
  rebuildAnalysis(indexName: string): Promise<void>
  /** Returns a snapshot of one index as the bytes of one `.nrsl` file. */
  snapshot(indexName: string): Promise<Uint8Array>
  /**
   * Writes a snapshot of one index into a file and resolves with its size in
   * bytes. A relative path resolves against the app's private storage, and
   * the file replaces any file at that path only once every byte is on disk.
   */
  snapshotToFile(indexName: string, path: string): Promise<number>
  /** Replaces one index with the snapshot in these bytes. */
  restore(indexName: string, data: Uint8Array): Promise<void>
  /** Replaces one index with the snapshot in a file, which the engine reads in chunks. */
  restoreFromFile(indexName: string, path: string): Promise<void>
  /** Returns every document of one index as the bytes of a document export. */
  exportDocuments(indexName: string): Promise<Uint8Array>
  /** Writes a document export of one index into a file and resolves with its size in bytes. */
  exportDocumentsToFile(indexName: string, path: string): Promise<number>
  /** Inserts the documents of a document export held in these bytes. */
  importDocumentExport(indexName: string, data: Uint8Array): Promise<DocumentImportResult>
  /** Inserts the documents of a document export held in a file. */
  importDocumentExportFromFile(indexName: string, path: string): Promise<DocumentImportResult>
  /** Writes an index's current state to the durability directory, so a restart replays less of the log. */
  checkpoint(indexName: string): Promise<void>
  /** Removes every document from an index and keeps the index, its schema, and its settings. */
  clear(indexName: string): Promise<void>
  /** Spreads an index's documents across a different number of partitions. */
  rebalance(indexName: string, targetPartitionCount: number): Promise<void>
  /** Changes how an index grows into new partitions. */
  updatePartitionConfig(indexName: string, config: Partial<PartitionConfig>): Promise<void>
  /** Reports what this engine and the app's process use. */
  getMemoryStats(): Promise<MemoryStats>
  /** Rebuilds a vector field's graph without the tombstones that removed documents left behind. */
  compactVectors(indexName: string, fieldName?: string): Promise<void>
  /** Rebuilds a vector field's graph from scratch, which recovers recall. */
  optimizeVectors(indexName: string, fieldName?: string): Promise<void>
  /** Reports the state of each vector field in an index, and what its maintenance would cost. */
  vectorMaintenanceStatus(indexName: string): Promise<VectorMaintenanceResult[]>
  /** Opens a closed index. */
  open(indexName: string): Promise<void>
  /** Closes an index. */
  close(indexName: string): Promise<void>
  /** Inserts one document and resolves with the id that it is stored under. */
  insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string>
  /** Inserts many documents in one request. */
  insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult>
  /** Removes one document. */
  remove(indexName: string, docId: string, options?: WriteOptions): Promise<void>
  /** Removes many documents in one request. */
  removeBatch(indexName: string, docIds: string[], options?: WriteOptions): Promise<BatchResult>
  /** Replaces one stored document. */
  update(indexName: string, docId: string, document: AnyDocument, options?: WriteOptions): Promise<void>
  /** Replaces many stored documents in one request. */
  updateBatch(
    indexName: string,
    updates: Array<{ docId: string; document: AnyDocument }>,
    options?: WriteOptions,
  ): Promise<BatchResult>
  /** Resolves once every worker copy of an index has applied every earlier write. */
  waitForWrites(indexName: string): Promise<void>
  /** Replaces the synonym rules of one index. */
  updateSynonyms(indexName: string, synonyms: SynonymRule[]): Promise<void>
  /** Returns the synonym rules of one index. */
  getSynonyms(indexName: string): Promise<SynonymRule[]>
  /** Changes how one index analyses text, and re-analyses its documents. */
  changeAnalysis(indexName: string, change: AnalysisChange): Promise<void>
  /** Changes the BM25 parameters of one index. */
  updateBM25(indexName: string, bm25: BM25Params): Promise<void>
  /** Calls a handler on the app's JS thread for each engine event of one kind. */
  on<K extends keyof NarsilEventMap>(event: K, handler: PhoneEventHandler<K>): void
  /** Stops calling a handler that {@link PhoneNarsil.on} registered. */
  off<K extends keyof NarsilEventMap>(event: K, handler: PhoneEventHandler<K>): void
  /** Shuts the engine down, after which every other method rejects with `INSTANCE_SHUT_DOWN`. */
  shutdown(): Promise<void>
}
