import { encodeJson } from '../json-encoding'
import type { MemoryStatsResponse, TaskRecord } from '../server/types'
import type { VectorMaintenanceResult } from '../types/results'
import type { PartitionConfig } from '../types/schema'
import type { SynonymRule } from '../types/synonyms'
import { NO_TIMEOUT } from './constants'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readArray, readBody } from './response-shape'

/**
 * These methods carry out the operations that maintain an index: checkpoints,
 * snapshots, document exports, vector maintenance, partitioning, and analysis
 * rebuilds.
 *
 * Five of them can take minutes, so each answers with a {@link TaskRecord}
 * while the work continues. Follow that task with
 * {@link TaskOperations.waitForTask}. The {@link Narsil} methods that they
 * mirror finish their work before they resolve, which is the one place where
 * this client differs from the engine.
 *
 * @public
 */
export interface AdminOperations {
  /**
   * Writes everything an index holds to durable storage, so recovery starts
   * from this point instead of replaying the log from the previous one.
   *
   * @param indexName - This names the index to checkpoint.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   */
  checkpoint(indexName: string, options?: RequestOptions): Promise<void>
  /**
   * Returns a stream of an index's snapshot archive. Any implementation of
   * the Narsil format can restore the archive.
   *
   * The download takes longer as the index grows, so this method sets no
   * deadline of its own. It waits until the download ends, unless
   * {@link NarsilClientOptions.timeoutMs} or a per-call `timeoutMs` sets a
   * deadline.
   *
   * @param indexName - This names the index to stream.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The stream holds the archive's bytes in the order that the server
   * sends them.
   */
  snapshot(indexName: string, options?: RequestOptions): Promise<ReadableStream<Uint8Array>>
  /**
   * Uploads a snapshot archive and replaces the named index with the
   * archive's contents. The method also accepts the single `.nrsl` file that
   * `snapshot` returned in release 0.3.
   *
   * The server writes the upload to a temporary file and restores the index
   * in a task. This method therefore resolves once the server holds the whole
   * upload, and the task's status changes to `succeeded` once the restored
   * index is ready.
   *
   * @param indexName - This names the index to replace.
   * @param data - This is the archive, as one byte array or a stream of bytes.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record is the task to follow.
   * @throws A `NarsilError` with `PAYLOAD_TOO_LARGE` when the upload passes
   * the server's `maxRestoreBytes` limit, and with `EMPTY_BODY` for an empty
   * upload. The task reports `PERSISTENCE_LOAD_FAILED`,
   * `PERSISTENCE_CRC_MISMATCH`, `ENVELOPE_VERSION_MISMATCH`, or
   * `CONFIG_INVALID` in its `error` when a check of the archive fails.
   */
  restore(
    indexName: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    options?: RequestOptions,
  ): Promise<TaskRecord>
  /**
   * Returns a stream of an index's document export. The export is JSON Lines
   * text, with the index configuration on the first line and one document on
   * each later line. Pass the export to
   * {@link AdminOperations.importDocumentExport} to load it into a server of
   * this release or a later one.
   *
   * The download takes longer as the index grows, so this method sets no
   * deadline of its own. It waits until the download ends, unless
   * {@link NarsilClientOptions.timeoutMs} or a per-call `timeoutMs` sets a
   * deadline.
   *
   * @param indexName - This names the index to export.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The stream holds the export's UTF-8 bytes in the order that the
   * server sends them.
   */
  exportDocuments(indexName: string, options?: RequestOptions): Promise<ReadableStream<Uint8Array>>
  /**
   * Uploads a document export and imports it into an index in a task. Where
   * the name is free, the engine creates the index from the export's
   * configuration. The engine replaces each document whose ID the index
   * already contains.
   *
   * The server writes the upload to a temporary file before the task starts,
   * so this method resolves once the server holds the whole upload. When the
   * task finishes, its result holds the number of imported documents and the
   * refused lines.
   *
   * @param indexName - This names the index that receives the documents.
   * @param data - This is the export, as one byte array or a stream of bytes.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record is the task to follow.
   * @throws A `NarsilError` with `PAYLOAD_TOO_LARGE` when the upload passes
   * the server's `maxRestoreBytes` limit, and with `EMPTY_BODY` for an empty
   * upload. The task reports `CONFIG_INVALID` in its `error` when the first
   * line is anything other than an export header, or when the named index
   * exists with a different schema.
   */
  importDocumentExport(
    indexName: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    options?: RequestOptions,
  ): Promise<TaskRecord>
  /**
   * Reports the state of each vector field, and what maintenance would cost.
   *
   * @param indexName - This names the index to describe.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns Each vector field appears once.
   */
  vectorMaintenanceStatus(indexName: string, options?: RequestOptions): Promise<VectorMaintenanceResult[]>
  /**
   * Reclaims the space removed vectors left behind, which a search would
   * otherwise scan past.
   *
   * @param indexName - This names the index to compact.
   * @param fieldName - This names one vector field, and omitting it covers
   * every one.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   */
  compactVectors(indexName: string, fieldName?: string, options?: RequestOptions): Promise<void>
  /**
   * Rebuilds the vector graphs as a task, so searches run at full speed again.
   *
   * @param indexName - This names the index to optimise.
   * @param fieldName - This names one vector field, and omitting it covers
   * every one.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record is the task to follow.
   */
  optimizeVectors(indexName: string, fieldName?: string, options?: RequestOptions): Promise<TaskRecord>
  /**
   * Spreads an index across a different number of partitions, as a task.
   *
   * The server holds the writes that arrive while it runs and replays them in
   * order, so an index stays writable throughout.
   *
   * @param indexName - This names the index to reshape.
   * @param targetPartitionCount - The index ends up with this many partitions.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record is the task to follow.
   */
  rebalance(indexName: string, targetPartitionCount: number, options?: RequestOptions): Promise<TaskRecord>
  /**
   * Changes when an index splits into another partition, and how far it may
   * grow.
   *
   * @param indexName - This names the index to reconfigure.
   * @param partitionConfig - These are the settings to change, and the rest
   * stay as they are.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @throws A `NarsilError` with `PARTITION_CAPACITY_EXCEEDED` when the new
   * ceiling falls below what the index already holds.
   */
  updatePartitionConfig(
    indexName: string,
    partitionConfig: Partial<PartitionConfig>,
    options?: RequestOptions,
  ): Promise<void>
  /**
   * Replaces the synonym set of an index, which takes effect from the next
   * search without a rebuild. Send an empty list to remove the set.
   *
   * @param indexName - This names the index whose set the server replaces.
   * @param synonyms - This is the new set, in the shape that
   * {@link SynonymRule} describes.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @throws A `NarsilError` with `CONFIG_INVALID` when a rule breaks that
   * shape, when a word analyses to no token or to more than one, or when the
   * set passes its limits. The index then keeps the set that it held before.
   */
  updateSynonyms(indexName: string, synonyms: SynonymRule[], options?: RequestOptions): Promise<void>
  /**
   * Reads the synonym set of an index, with every word as the caller wrote it.
   *
   * @param indexName - This names the index whose set the server returns.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The rules of the set, or an empty list when the index holds none.
   */
  getSynonyms(indexName: string, options?: RequestOptions): Promise<SynonymRule[]>
  /**
   * Reanalyses every document in an index, as a task. An index analysed by an
   * earlier revision of its language module must run this before its terms
   * match again.
   *
   * A result with `analysisStale: true` says the index is due one.
   *
   * @param indexName - This names the index to reanalyse.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record is the task to follow.
   */
  rebuildAnalysis(indexName: string, options?: RequestOptions): Promise<TaskRecord>
  /**
   * Reports the server process's heap usage, its estimate of what the indexes
   * hold, each worker's heap, and how many worker threads receive requests.
   *
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The figures are what you size a host from.
   */
  getMemoryStats(options?: RequestOptions): Promise<MemoryStatsResponse>
}

export function createAdminOperations(transport: Transport): AdminOperations {
  async function postJson<T>(path: string, body: unknown, options: RequestOptions | undefined): Promise<T> {
    const payload = await transport.json({
      method: 'POST',
      path,
      body: encodeJson(body),
      contentType: 'application/json',
      options,
    })
    return readBody<T>(payload, path)
  }

  return {
    async checkpoint(indexName, options) {
      await transport.json({ method: 'POST', path: `${indexPath(indexName)}/_checkpoint`, options })
    },
    snapshot(indexName, options) {
      return transport.stream({
        method: 'GET',
        path: `${indexPath(indexName)}/snapshot`,
        defaultTimeoutMs: NO_TIMEOUT,
        options,
      })
    },
    async restore(indexName, data, options) {
      const path = `${indexPath(indexName)}/restore`
      const payload = await transport.json({
        method: 'POST',
        path,
        body: data,
        contentType: 'application/octet-stream',
        defaultTimeoutMs: NO_TIMEOUT,
        options,
      })
      return readBody<TaskRecord>(payload, path)
    },
    exportDocuments(indexName, options) {
      return transport.stream({
        method: 'GET',
        path: `${indexPath(indexName)}/export`,
        defaultTimeoutMs: NO_TIMEOUT,
        options,
      })
    },
    async importDocumentExport(indexName, data, options) {
      const path = `${indexPath(indexName)}/import`
      const payload = await transport.json({
        method: 'POST',
        path,
        body: data,
        contentType: 'application/x-ndjson',
        defaultTimeoutMs: NO_TIMEOUT,
        options,
      })
      return readBody<TaskRecord>(payload, path)
    },
    async vectorMaintenanceStatus(indexName, options) {
      const path = `${indexPath(indexName)}/vector-maintenance`
      const payload = await transport.json({ method: 'GET', path, options })
      return readArray<VectorMaintenanceResult>(payload, 'fields', path)
    },
    async compactVectors(indexName, fieldName, options) {
      await postJson(
        `${indexPath(indexName)}/vectors/_compact`,
        fieldName === undefined ? {} : { field: fieldName },
        options,
      )
    },
    optimizeVectors(indexName, fieldName, options) {
      return postJson<TaskRecord>(
        `${indexPath(indexName)}/vectors/_optimize`,
        fieldName === undefined ? {} : { field: fieldName },
        options,
      )
    },
    rebalance(indexName, targetPartitionCount, options) {
      return postJson<TaskRecord>(`${indexPath(indexName)}/_rebalance`, { targetPartitionCount }, options)
    },
    async updatePartitionConfig(indexName, partitionConfig, options) {
      await postJson(`${indexPath(indexName)}/partition-config`, partitionConfig, options)
    },
    async updateSynonyms(indexName, synonyms, options) {
      await postJson(`${indexPath(indexName)}/synonyms`, { synonyms }, options)
    },
    async getSynonyms(indexName, options) {
      const path = `${indexPath(indexName)}/synonyms`
      const body = await readBody<{ synonyms: SynonymRule[] }>(
        await transport.json({ method: 'GET', path, options }),
        path,
      )
      return body.synonyms
    },
    async rebuildAnalysis(indexName, options) {
      const path = `${indexPath(indexName)}/_rebuild-analysis`
      return readBody<TaskRecord>(await transport.json({ method: 'POST', path, options }), path)
    },
    async getMemoryStats(options) {
      const path = '/stats/memory'
      return readBody<MemoryStatsResponse>(await transport.json({ method: 'GET', path, options }), path)
    },
  }
}
