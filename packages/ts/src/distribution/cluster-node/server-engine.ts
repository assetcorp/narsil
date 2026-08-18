import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../types/engine'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { ClusterNode, CreateIndexOptions } from './types'

/**
 * How {@link clusterNodeEngine} shapes the operations it forwards.
 *
 * @public
 */
export interface ClusterEngineOptions {
  /** Every index created through the adapter is spread with these settings, and with the cluster defaults otherwise. */
  createIndex?: CreateIndexOptions
}

function unsupported(operation: string): never {
  throw new NarsilError(
    ErrorCodes.CLUSTER_OPERATION_UNSUPPORTED,
    `A cluster node does not serve '${operation}' yet; run it against a single-node engine`,
    { operation },
  )
}

/**
 * Adapts a cluster node to the {@link Narsil} interface, so
 * `createServer` from `@delali/narsil/server` serves the cluster the way it
 * serves a single engine.
 *
 * Writes, searches, index creation, and document reads route through the
 * cluster. Every other operation fails with `CLUSTER_OPERATION_UNSUPPORTED`,
 * which the HTTP server answers with status 501, so a caller learns the
 * operation is missing rather than reading a wrong answer.
 *
 * @param node - The cluster node the adapter serves.
 * @param options - How the forwarded operations are shaped, such as the
 * partition count and replication factor of created indexes.
 * @returns The node behind the {@link Narsil} interface.
 *
 * @public
 */
export function clusterNodeEngine(node: ClusterNode, options?: ClusterEngineOptions): Narsil {
  return {
    async createIndex(name: string, config: IndexConfig): Promise<void> {
      return node.createIndex(name, config, options?.createIndex)
    },

    async insert(indexName: string, document: AnyDocument, docId?: string): Promise<string> {
      return node.insert(indexName, document, docId)
    },

    async insertBatch(indexName: string, documents: AnyDocument[]) {
      return node.insertBatch(indexName, documents)
    },

    async remove(indexName: string, docId: string): Promise<void> {
      return node.remove(indexName, docId)
    },

    async removeBatch(indexName: string, docIds: string[]) {
      return node.removeBatch(indexName, docIds)
    },

    async query<T = AnyDocument>(indexName: string, params: QueryParams) {
      return node.query<T>(indexName, params)
    },

    async get(indexName: string, docId: string) {
      return node.get(indexName, docId)
    },

    async getMultiple(indexName: string, docIds: string[]) {
      return node.getMultiple(indexName, docIds)
    },

    async has(indexName: string, docId: string) {
      return node.has(indexName, docId)
    },

    async shutdown(): Promise<void> {
      return node.shutdown()
    },

    registerEmbeddingAdapter: () => unsupported('registerEmbeddingAdapter'),
    dropIndex: () => unsupported('dropIndex'),
    listIndexes: () => unsupported('listIndexes'),
    getStats: () => unsupported('getStats'),
    getPartitionStats: () => unsupported('getPartitionStats'),
    update: () => unsupported('update'),
    updateBatch: () => unsupported('updateBatch'),
    countDocuments: () => unsupported('countDocuments'),
    listDocuments: () => unsupported('listDocuments'),
    preflight: () => unsupported('preflight'),
    suggest: () => unsupported('suggest'),
    rebuildAnalysis: () => unsupported('rebuildAnalysis'),
    snapshot: () => unsupported('snapshot'),
    restore: () => unsupported('restore'),
    checkpoint: () => unsupported('checkpoint'),
    clear: () => unsupported('clear'),
    rebalance: () => unsupported('rebalance'),
    updatePartitionConfig: () => unsupported('updatePartitionConfig'),
    getMemoryStats: () => unsupported('getMemoryStats'),
    compactVectors: () => unsupported('compactVectors'),
    optimizeVectors: () => unsupported('optimizeVectors'),
    vectorMaintenanceStatus: () => unsupported('vectorMaintenanceStatus'),
    on: () => unsupported('on'),
    off: () => unsupported('off'),
  }
}
