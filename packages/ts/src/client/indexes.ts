import type { HttpIndexConfig } from '../server/types'
import type { IndexInfo, IndexStats, PartitionStatsResult } from '../types/results'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readArray, readBody } from './response-shape'

/**
 * These methods create, list, describe, and drop indexes over HTTP.
 *
 * Each one has the name of the {@link Narsil} method it mirrors, so a call
 * written against an embedded engine works against a server.
 *
 * @public
 */
export interface IndexOperations {
  /**
   * Creates an index you can insert documents into and query.
   *
   * The configuration covers whatever JSON can express of the engine's own. A
   * custom tokeniser, a stop-word function, and an embedding adapter are all
   * functions, so name a language and a server-registered adapter instead.
   *
   * @param name - Every later call uses this name to reach the index.
   * @param config - This holds the schema, the language, and the partitioning
   * and scoring settings, in the form JSON can express.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @throws A `NarsilError` with `INDEX_ALREADY_EXISTS` when the name is taken,
   * and with `CONFIG_INVALID` when the server refuses the settings.
   */
  createIndex(name: string, config: HttpIndexConfig, options?: RequestOptions): Promise<void>
  /**
   * Lists every index the server holds, with its size and its language.
   *
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns Each index appears once, in creation order.
   */
  listIndexes(options?: RequestOptions): Promise<IndexInfo[]>
  /**
   * Removes an index and everything it holds. The documents do not come back.
   *
   * @param name - This names the index to drop.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   */
  dropIndex(name: string, options?: RequestOptions): Promise<void>
  /**
   * Returns one index's document count, partition count, memory estimate,
   * language, and schema.
   *
   * @param indexName - This names the index to describe.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The figures describe the index as it stands now.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` for an unknown name.
   */
  getStats(indexName: string, options?: RequestOptions): Promise<IndexStats>
  /**
   * Returns per-partition figures for one index, which is where you look when
   * an index fills unevenly.
   *
   * @param indexName - This names the index to describe.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns Each partition appears once, in partition order.
   */
  getPartitionStats(indexName: string, options?: RequestOptions): Promise<PartitionStatsResult[]>
  /**
   * Removes every document from an index while the index itself stays, with its
   * schema and its settings.
   *
   * @param indexName - This names the index to empty.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
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
