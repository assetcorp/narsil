import { encodeJson } from '../json-encoding'
import type { TaskRecord } from '../server/types'
import type { MemoryStats } from '../types/memory'
import type { VectorMaintenanceResult } from '../types/results'
import type { PartitionConfig } from '../types/schema'
import { NO_TIMEOUT } from './constants'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readArray, readBody } from './response-shape'

/**
 * These methods run the operations that maintain an index: checkpoints,
 * snapshots, vector maintenance, partitioning, and analysis rebuilds.
 *
 * Four of them can run for minutes, so each answers with a {@link TaskRecord}
 * while the work carries on, and you follow it with
 * {@link TaskOperations.waitForTask}. The {@link Narsil} methods they mirror
 * return nothing and finish before they resolve, which is the one place this
 * client parts from the engine.
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
   * Downloads one index as a portable `.nrsl` file, which any Narsil
   * implementation can read back.
   *
   * The whole index crosses the network, so this call sets no deadline of its
   * own and waits for as long as the download takes until
   * {@link NarsilClientOptions.timeoutMs} or a per-call `timeoutMs` sets one.
   *
   * @param indexName - This names the index to serialise.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The bytes make up the file.
   */
  snapshot(indexName: string, options?: RequestOptions): Promise<Uint8Array>
  /**
   * Replaces an index with the contents of a `.nrsl` file, dropping whatever
   * the index held.
   *
   * The load runs as a task, so this resolves once the server has read the
   * bytes, and the index comes back afterwards.
   *
   * @param indexName - This names the index to replace.
   * @param data - These are the file's bytes.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The record is the task to follow.
   * @throws A `NarsilError` with `DOC_VALIDATION_FAILED` or an `ENVELOPE_`
   * code, reported on the task, when the bytes hold no readable snapshot.
   */
  restore(indexName: string, data: Uint8Array, options?: RequestOptions): Promise<TaskRecord>
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
   * hold, and each worker's heap.
   *
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The figures are what you size a host from.
   */
  getMemoryStats(options?: RequestOptions): Promise<MemoryStats>
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
      return transport.binary({
        method: 'GET',
        path: `${indexPath(indexName)}/snapshot`,
        binaryAnswer: true,
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
    async rebuildAnalysis(indexName, options) {
      const path = `${indexPath(indexName)}/_rebuild-analysis`
      return readBody<TaskRecord>(await transport.json({ method: 'POST', path, options }), path)
    },
    async getMemoryStats(options) {
      const path = '/stats/memory'
      return readBody<MemoryStats>(await transport.json({ method: 'GET', path, options }), path)
    },
  }
}
