import { NarsilError, ServerErrorCodes } from '../errors'
import type { ImportResult, TaskRecord } from '../server/types'
import type { BatchResult, ListResult } from '../types/results'
import type { AnyDocument, InsertOptions } from '../types/schema'
import type { ListParams } from '../types/search'
import { NO_TIMEOUT, type Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readArray, readBody, readObject } from './response-shape'

/**
 * A corpus, in whichever form you already hold it.
 *
 * The client encodes documents as NDJSON. It sends a string or a byte array
 * unchanged, so NDJSON read from a file needs no re-encoding.
 *
 * @public
 */
export type ImportSource = AnyDocument[] | string | Uint8Array

/**
 * Writing and reading many documents in one request.
 *
 * A batch reports every document's outcome, so one refusal leaves the rest
 * written. An import streams a corpus, which the server writes in bounded
 * batches.
 *
 * @public
 */
export interface BulkOperations {
  /**
   * Adds many documents in one request and reports each one's outcome.
   *
   * A document the server rejects appears in `failed` with the error that
   * rejected it, and every other document is still written.
   *
   * @param indexName - The index that receives the documents.
   * @param documents - The documents to write, each carrying its own id or
   * leaving the server to generate one.
   * @param insertOptions - Per-write settings applied to every document.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The ids written, and each rejection with its error.
   */
  insertBatch(
    indexName: string,
    documents: AnyDocument[],
    insertOptions?: InsertOptions,
    options?: RequestOptions,
  ): Promise<BatchResult>
  /**
   * Replaces many documents in one request and reports each one's outcome.
   *
   * @param indexName - The index holding the documents.
   * @param updates - Each entry names the document to replace and its
   * replacement.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The ids replaced, and each failure with its error.
   */
  updateBatch(
    indexName: string,
    updates: Array<{ docId: string; document: AnyDocument }>,
    options?: RequestOptions,
  ): Promise<BatchResult>
  /**
   * Removes many documents in one request and reports each one's outcome.
   *
   * @param indexName - The index holding the documents.
   * @param docIds - The documents to remove.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The ids removed, and each failure with its error.
   */
  removeBatch(indexName: string, docIds: string[], options?: RequestOptions): Promise<BatchResult>
  /**
   * Reads many documents by id in one request.
   *
   * The result leaves out an id the index does not hold, and the call still
   * succeeds, so compare the size against what you asked for.
   *
   * @param indexName - The index holding the documents.
   * @param docIds - The ids to read.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The documents found, keyed by id.
   */
  getMultiple(indexName: string, docIds: string[], options?: RequestOptions): Promise<Map<string, AnyDocument>>
  /**
   * Pages through the stored documents without searching, in document-id order
   * until the parameters name a sort.
   *
   * @typeParam T - Shape of the stored documents.
   * @param indexName - The index to page through.
   * @param params - The page size, the cursor, and any filter, sort, or
   * projection.
   * @param options - Per-call signal, deadline, and headers.
   * @returns One page, with the cursor that reaches the next.
   */
  listDocuments<T = AnyDocument>(
    indexName: string,
    params?: ListParams,
    options?: RequestOptions,
  ): Promise<ListResult<T>>
  /**
   * Loads a corpus in one request and answers once the whole load has finished.
   *
   * The server writes the documents in bounded batches, so one bad record never
   * abandons the rest. For a load that would outlast a proxy's response
   * timeout, use {@link BulkOperations.startImport}, which answers straight
   * away and reports progress through a task.
   *
   * This call sets no deadline of its own. It waits for as long as the load
   * takes unless {@link NarsilClientOptions.timeoutMs} or a per-call
   * `timeoutMs` sets one.
   *
   * @param indexName - The index that receives the corpus.
   * @param source - The documents, or NDJSON you already hold.
   * @param options - Per-call signal, deadline, and headers.
   * @returns How many documents the server accepted and refused, with the first
   * refusals.
   * @throws A `NarsilError` with `PAYLOAD_TOO_LARGE` when the corpus passes the
   * server's import limit, which defaults to 100 MB.
   */
  importDocuments(indexName: string, source: ImportSource, options?: RequestOptions): Promise<ImportResult>
  /**
   * Starts a corpus load as a task, and answers once the server has read the
   * body. A load longer than a request timeout runs this way.
   *
   * Follow the returned record with {@link TaskOperations.waitForTask}, which
   * reports the bytes read as the load runs. Stop the load with
   * {@link TaskOperations.cancelTask}.
   *
   * This call sets no deadline of its own, so it waits for the server to read
   * the body unless {@link NarsilClientOptions.timeoutMs} or a per-call
   * `timeoutMs` sets one.
   *
   * @param indexName - The index that receives the corpus.
   * @param source - The documents, or NDJSON you already hold.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The task record to poll.
   * @throws A `NarsilError` with `NOT_FOUND` when the server predates the
   * asynchronous import. {@link ServerOperations.supports} reports that before
   * you call.
   */
  startImport(indexName: string, source: ImportSource, options?: RequestOptions): Promise<TaskRecord>
}

function toNdjson(source: ImportSource): string | Uint8Array {
  if (typeof source === 'string') return source
  if (Array.isArray(source)) return source.map(document => JSON.stringify(document)).join('\n')
  return source
}

function toBatchResult(payload: unknown, path: string): BatchResult {
  const failed = readArray<unknown>(payload, 'failed', path)
  return {
    succeeded: readArray<string>(payload, 'succeeded', path),
    failed: failed.map(entry => {
      const record = readBody<{ docId?: unknown; error?: unknown }>(entry, path)
      const docId = typeof record.docId === 'string' ? record.docId : ''
      const error = readBody<{ code?: unknown; message?: unknown; details?: unknown }>(record.error, path)
      const code = typeof error.code === 'string' ? error.code : ServerErrorCodes.INTERNAL_ERROR
      const message = typeof error.message === 'string' ? error.message : 'The server refused the document'
      const details = typeof error.details === 'object' && error.details !== null ? error.details : undefined
      return { docId, error: new NarsilError(code, message, details as Record<string, unknown> | undefined) }
    }),
  }
}

export function createBulkOperations(transport: Transport): BulkOperations {
  function batch(indexName: string, body: unknown, options: RequestOptions | undefined): Promise<BatchResult> {
    const path = `${indexPath(indexName)}/documents/_batch`
    return transport
      .json({ method: 'POST', path, body: JSON.stringify(body), contentType: 'application/json', options })
      .then(payload => toBatchResult(payload, path))
  }

  function importBody(indexName: string, source: ImportSource, asynchronous: boolean, options?: RequestOptions) {
    return {
      method: 'POST' as const,
      path: `${indexPath(indexName)}/documents/_import`,
      ...(asynchronous ? { query: { async: 'true' } } : {}),
      body: toNdjson(source),
      contentType: 'application/x-ndjson',
      defaultTimeoutMs: NO_TIMEOUT,
      options,
    }
  }

  return {
    insertBatch(indexName, documents, insertOptions, options) {
      return batch(
        indexName,
        { action: 'insert', documents, ...(insertOptions === undefined ? {} : { options: insertOptions }) },
        options,
      )
    },
    updateBatch(indexName, updates, options) {
      return batch(indexName, { action: 'update', updates }, options)
    },
    removeBatch(indexName, docIds, options) {
      return batch(indexName, { action: 'delete', docIds }, options)
    },
    async getMultiple(indexName, docIds, options) {
      const path = `${indexPath(indexName)}/documents/_multi-get`
      const payload = await transport.json({
        method: 'POST',
        path,
        body: JSON.stringify({ docIds }),
        contentType: 'application/json',
        options,
      })
      const documents = readObject<Record<string, AnyDocument>>(payload, 'documents', path)
      return new Map(Object.entries(documents))
    },
    async listDocuments<T = AnyDocument>(indexName: string, params?: ListParams, options?: RequestOptions) {
      const path = `${indexPath(indexName)}/documents/_list`
      const payload = await transport.json({
        method: 'POST',
        path,
        body: JSON.stringify(params ?? {}),
        contentType: 'application/json',
        options,
      })
      return readBody<ListResult<T>>(payload, path)
    },
    async importDocuments(indexName, source, options) {
      const spec = importBody(indexName, source, false, options)
      return readBody<ImportResult>(await transport.json(spec), spec.path)
    },
    async startImport(indexName, source, options) {
      const spec = importBody(indexName, source, true, options)
      return readBody<TaskRecord>(await transport.json(spec), spec.path)
    },
  }
}
