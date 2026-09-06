import { ErrorCodes } from '../errors'
import { encodeJson } from '../json-encoding'
import type { AnyDocument, InsertOptions, WriteOptions } from '../types/schema'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { documentPath, indexPath } from './paths'
import { readBoolean, readNumber, readObject, readString } from './response-shape'

/**
 * This says what an upsert did, which is how {@link DocumentOperations.put}
 * reports whether the id already held a document.
 *
 * @public
 */
export interface PutResult {
  /** The document is stored under this id. */
  id: string
  /** This is true when the id held nothing before, and false when the write replaced a document. */
  created: boolean
}

/**
 * These methods write and read one document at a time over HTTP.
 *
 * Each one has the name of the {@link Narsil} method it mirrors. Reach for
 * {@link BulkOperations} to load a corpus, because a document per request would
 * cost a round trip each.
 *
 * @public
 */
export interface DocumentOperations {
  /**
   * Adds one document to an index and returns the id it is stored under.
   *
   * The id comes from the `docId` argument when you pass one, otherwise from
   * the document's own `id` field, and otherwise the server generates it.
   *
   * @param indexName - This names the index that receives the document.
   * @param document - Its fields must match the types the schema declares.
   * @param docId - Pass an id to control it yourself, or omit it and read the
   * returned value.
   * @param insertOptions - These per-write settings reach the server, such as
   * skipping the defensive copy.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The document is stored under this id.
   */
  insert(
    indexName: string,
    document: AnyDocument,
    docId?: string,
    insertOptions?: InsertOptions,
    options?: RequestOptions,
  ): Promise<string>
  /**
   * Reads one stored document back.
   *
   * @param indexName - This names the index holding the document.
   * @param docId - This names the document to read.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The stored document comes back, and `undefined` says the index
   * holds no such id.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` for an unknown index.
   */
  get(indexName: string, docId: string, options?: RequestOptions): Promise<AnyDocument | undefined>
  /**
   * Reports whether an index holds a document under an id, without returning
   * the document itself.
   *
   * @param indexName - This names the index to look in.
   * @param docId - This is the id to look for.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns This is true when the id holds a document.
   */
  has(indexName: string, docId: string, options?: RequestOptions): Promise<boolean>
  /**
   * Writes a document at an id, whether or not one is already there, which
   * suits an application that assigns its own identifiers.
   *
   * @param indexName - This names the index that receives the document.
   * @param docId - This is the id to write at.
   * @param document - Its fields must match the types the schema declares.
   * @param writeOptions - These per-write settings reach the server, such as
   * waiting for every worker copy to apply the write.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The result names the id, and says whether the write created the
   * document or replaced one.
   */
  put(
    indexName: string,
    docId: string,
    document: AnyDocument,
    writeOptions?: WriteOptions,
    options?: RequestOptions,
  ): Promise<PutResult>
  /**
   * Replaces the stored document at an id.
   *
   * @param indexName - This names the index holding the document.
   * @param docId - This names the document to replace.
   * @param document - This replacement goes through the same schema validation
   * an insert would.
   * @param writeOptions - These per-write settings reach the server, such as
   * waiting for every worker copy to apply the write.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @throws A `NarsilError` with `DOC_NOT_FOUND` when the index holds no such
   * document.
   */
  update(
    indexName: string,
    docId: string,
    document: AnyDocument,
    writeOptions?: WriteOptions,
    options?: RequestOptions,
  ): Promise<void>
  /**
   * Removes one document.
   *
   * @param indexName - This names the index holding the document.
   * @param docId - This names the document to remove.
   * @param writeOptions - These per-write settings reach the server, such as
   * waiting for every worker copy to apply the removal.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @throws A `NarsilError` with `DOC_NOT_FOUND` when the index holds no such
   * document.
   */
  remove(indexName: string, docId: string, writeOptions?: WriteOptions, options?: RequestOptions): Promise<void>
  /**
   * Resolves once every worker copy of an index on the server has applied
   * every write that returned before the call.
   *
   * A write returns once the server's main copy holds it, and the copies
   * apply it afterwards, so a query can come back without a write that
   * returned before it. Call this after a run of writes, or pass `wait: true`
   * on one write, before a query that has to see them.
   *
   * @param indexName - This names the index whose copies have to catch up.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   */
  waitForWrites(indexName: string, options?: RequestOptions): Promise<void>
  /**
   * Counts the documents in an index.
   *
   * @param indexName - This names the index to count.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The count covers every document the index holds.
   */
  countDocuments(indexName: string, options?: RequestOptions): Promise<number>
}

export function createDocumentOperations(transport: Transport): DocumentOperations {
  return {
    async insert(indexName, document, docId, insertOptions, options) {
      const path = `${indexPath(indexName)}/documents`
      const payload = await transport.json({
        method: 'POST',
        path,
        body: encodeJson({
          document,
          ...(docId === undefined ? {} : { id: docId }),
          ...(insertOptions === undefined ? {} : { options: insertOptions }),
        }),
        contentType: 'application/json',
        options,
      })
      return readString(payload, 'id', path)
    },
    async get(indexName, docId, options) {
      const path = documentPath(indexName, docId)
      const payload = await transport.jsonOrNull({ method: 'GET', path, options }, ErrorCodes.DOC_NOT_FOUND)
      if (payload === null) return undefined
      return readObject<AnyDocument>(payload, 'document', path)
    },
    async has(indexName, docId, options) {
      const path = `${documentPath(indexName, docId)}/_exists`
      return readBoolean(await transport.json({ method: 'GET', path, options }), 'exists', path)
    },
    async put(indexName, docId, document, writeOptions, options) {
      const path = documentPath(indexName, docId)
      const payload = await transport.json({
        method: 'PUT',
        path,
        body: encodeJson({ document, ...(writeOptions === undefined ? {} : { options: writeOptions }) }),
        contentType: 'application/json',
        options,
      })
      return { id: readString(payload, 'id', path), created: readBoolean(payload, 'created', path) }
    },
    async update(indexName, docId, document, writeOptions, options) {
      await transport.json({
        method: 'PATCH',
        path: documentPath(indexName, docId),
        body: encodeJson({ document, ...(writeOptions === undefined ? {} : { options: writeOptions }) }),
        contentType: 'application/json',
        options,
      })
    },
    async remove(indexName, docId, writeOptions, options) {
      await transport.json({
        method: 'DELETE',
        path: documentPath(indexName, docId),
        ...(writeOptions?.wait === true ? { query: { wait: 'true' } } : {}),
        options,
      })
    },
    async waitForWrites(indexName, options) {
      await transport.json({ method: 'POST', path: `${indexPath(indexName)}/_wait-for-writes`, options })
    },
    async countDocuments(indexName, options) {
      const path = `${indexPath(indexName)}/count`
      return readNumber(await transport.json({ method: 'GET', path, options }), 'count', path)
    },
  }
}
