import type { BatchResult } from './results'
import type { AnyDocument, InsertOptions, WriteOptions } from './schema'

/**
 * Adds, replaces, and removes documents, and waits for the worker copies to
 * catch up with those writes.
 *
 * A write returns once the main copy holds it, and the worker copies apply
 * it afterwards, so a query that a copy answers can come back without a write
 * that returned before it. Every write takes a `wait` option for the cases
 * where the next query has to see it.
 *
 * @public
 */
export interface DocumentWriteOperations {
  /**
   * Adds one document to an index and returns the id it is stored under.
   *
   * The id comes from the `docId` argument when you pass one, otherwise from
   * the document's own `id` field, and otherwise the engine generates it. Use
   * {@link DocumentWriteOperations.insertBatch} for a large load, so that one
   * bad document cannot abandon the rest.
   *
   * @param indexName - The index that receives the document.
   * @param document - Its fields must match the types the schema declares.
   * @param docId - Pass an id to control it yourself, or omit it and read the
   * returned value.
   * @param options - Per-write settings, such as skipping the defensive copy
   * or waiting for every worker copy to apply the write.
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
   * @param options - Per-write settings, such as waiting for every worker
   * copy to apply the removal.
   * @throws A `NarsilError` with `DOC_NOT_FOUND` when the index holds no such
   * document.
   */
  remove(indexName: string, docId: string, options?: WriteOptions): Promise<void>
  /**
   * Removes many documents in one pass and reports each one's outcome.
   *
   * @param indexName - The index holding the documents.
   * @param docIds - The documents to remove.
   * @param options - Per-write settings applied to the whole batch.
   * @returns The ids removed, and each failure with its error.
   */
  removeBatch(indexName: string, docIds: string[], options?: WriteOptions): Promise<BatchResult>
  /**
   * Replaces a stored document with the one you pass.
   *
   * The engine removes the old document and indexes the new one, so the
   * document you supply has to be complete, with every field it should hold
   * afterwards.
   *
   * @param indexName - The index holding the document.
   * @param docId - The document to replace.
   * @param document - The complete replacement.
   * @param options - Per-write settings, such as waiting for every worker
   * copy to apply the replacement.
   */
  update(indexName: string, docId: string, document: AnyDocument, options?: WriteOptions): Promise<void>
  /**
   * Replaces many documents in one pass and reports each one's outcome.
   *
   * @param indexName - The index holding the documents.
   * @param updates - Each id with the complete document that replaces it.
   * @param options - Per-write settings applied to the whole batch.
   * @returns The ids replaced, and each failure with its error.
   */
  updateBatch(
    indexName: string,
    updates: Array<{ docId: string; document: AnyDocument }>,
    options?: WriteOptions,
  ): Promise<BatchResult>
  /**
   * Resolves once every worker copy of an index has applied every write that
   * returned before the call.
   *
   * Call this after a run of writes, or pass `wait: true` on one write,
   * before a query that has to see them. An index that holds no copies
   * resolves at once.
   *
   * @param indexName - The index whose copies have to catch up.
   */
  waitForWrites(indexName: string): Promise<void>
}
