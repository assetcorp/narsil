import type { HttpIndexConfig } from '../server/types'
import type { IndexInfo, IndexStats, PartitionStatsResult } from '../types/results'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readArray, readBody } from './response-shape'

/**
 * Creating, listing, describing, and dropping indexes over HTTP.
 *
 * Each method has the name of the {@link Narsil} method it mirrors, so a call
 * written against an embedded engine works against a server.
 *
 * @public
 */
export interface IndexOperations {
  /**
   * Creates an index you can insert documents into and query.
   *
   * The configuration holds the part of the engine's that JSON can express. A
   * custom tokeniser, a stop-word function, and an embedding adapter are
   * functions, so the request names a language and a server-registered adapter
   * instead.
   *
   * @param name - Every later call uses this name to reach the index.
   * @param config - The schema, the language, and the partitioning and scoring
   * settings, in the form JSON can express.
   * @param options - Per-call signal, deadline, and headers.
   * @throws A `NarsilError` with `INDEX_ALREADY_EXISTS` when the name is taken,
   * and with `CONFIG_INVALID` when the server rejects the settings.
   */
  createIndex(name: string, config: HttpIndexConfig, options?: RequestOptions): Promise<void>
  /**
   * Lists every index the server holds, with its size and its language.
   *
   * @param options - Per-call signal, deadline, and headers.
   * @returns One entry per index, in creation order.
   */
  listIndexes(options?: RequestOptions): Promise<IndexInfo[]>
  /**
   * Removes an index and everything it holds. The documents do not come back.
   *
   * @param name - The index to drop.
   * @param options - Per-call signal, deadline, and headers.
   */
  dropIndex(name: string, options?: RequestOptions): Promise<void>
  /**
   * Returns one index's document count, partition count, memory estimate,
   * language, and schema.
   *
   * @param indexName - The index to describe.
   * @param options - Per-call signal, deadline, and headers.
   * @returns The index's current figures.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` for an unknown name.
   */
  getStats(indexName: string, options?: RequestOptions): Promise<IndexStats>
  /**
   * Returns per-partition figures for one index, which is where you look when
   * an index fills unevenly.
   *
   * @param indexName - The index to describe.
   * @param options - Per-call signal, deadline, and headers.
   * @returns One entry per partition, in partition order.
   */
  getPartitionStats(indexName: string, options?: RequestOptions): Promise<PartitionStatsResult[]>
  /**
   * Removes every document from an index and keeps the index itself, with its
   * schema and settings.
   *
   * @param indexName - The index to empty.
   * @param options - Per-call signal, deadline, and headers.
   */
  clear(indexName: string, options?: RequestOptions): Promise<void>
}

export function createIndexOperations(transport: Transport): IndexOperations {
  return {
    async createIndex(name, config, options) {
      await transport.json({
        method: 'POST',
        path: '/indexes',
        body: JSON.stringify({ name, config }),
        contentType: 'application/json',
        options,
      })
    },
    async listIndexes(options) {
      const path = '/indexes'
      return readArray<IndexInfo>(await transport.json({ method: 'GET', path, options }), 'indexes', path)
    },
    async dropIndex(name, options) {
      await transport.json({ method: 'DELETE', path: indexPath(name), options })
    },
    async getStats(indexName, options) {
      const path = `${indexPath(indexName)}/stats`
      return readBody<IndexStats>(await transport.json({ method: 'GET', path, options }), path)
    },
    async getPartitionStats(indexName, options) {
      const path = `${indexPath(indexName)}/partitions`
      const payload = await transport.json({ method: 'GET', path, options })
      return readArray<PartitionStatsResult>(payload, 'partitions', path)
    },
    async clear(indexName, options) {
      await transport.json({ method: 'POST', path: `${indexPath(indexName)}/_clear`, options })
    },
  }
}
