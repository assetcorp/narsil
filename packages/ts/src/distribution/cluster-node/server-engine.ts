import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../types/engine'
import type { AnyDocument, IndexConfig, InsertOptions } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
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
 * Writes, updates, searches, suggestions, listings, counts, index creation,
 * index removal, and document reads route through the cluster. Checkpointing,
 * memory statistics, and engine events reach this node's local engine, because
 * each covers a per-node fact. Every other operation fails with
 * `CLUSTER_OPERATION_UNSUPPORTED`, which the HTTP server answers with status
 * 501, so a caller learns the operation is missing rather than reading a
 * wrong answer. That covers `getStats`, `getPartitionStats`, and
 * `listIndexes` as well, because {@link Narsil} declares them synchronous and
 * a cluster answer needs a round trip; call them on the
 * {@link ClusterNode} itself, where they are asynchronous.
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

    async insert(
      indexName: string,
      document: AnyDocument,
      docId?: string,
      insertOptions?: InsertOptions,
    ): Promise<string> {
      return node.insert(indexName, document, docId, insertOptions)
    },

    async insertBatch(indexName: string, documents: AnyDocument[], insertOptions?: InsertOptions) {
      return node.insertBatch(indexName, documents, insertOptions)
    },

    async remove(indexName: string, docId: string): Promise<void> {
      return node.remove(indexName, docId)
    },

    async removeBatch(indexName: string, docIds: string[]) {
      return node.removeBatch(indexName, docIds)
    },

    async update(indexName: string, docId: string, document: AnyDocument): Promise<void> {
      return node.update(indexName, docId, document)
    },

    async updateBatch(indexName: string, updates: Array<{ docId: string; document: AnyDocument }>) {
      return node.updateBatch(indexName, updates)
    },

    async dropIndex(name: string): Promise<void> {
      return node.dropIndex(name)
    },

    async clear(indexName: string): Promise<void> {
      return node.clear(indexName)
    },

    async countDocuments(indexName: string): Promise<number> {
      return node.countDocuments(indexName)
    },

    async listDocuments<T = AnyDocument>(indexName: string, params?: ListParams) {
      return node.listDocuments<T>(indexName, params)
    },

    async suggest(indexName: string, params: SuggestParams) {
      return node.suggest(indexName, params)
    },

    async preflight(indexName: string, params: QueryParams) {
      return node.preflight(indexName, params)
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

    async checkpoint(indexName: string): Promise<void> {
      return node.checkpoint(indexName)
    },

    async getMemoryStats() {
      return node.getMemoryStats()
    },

    on(event, handler) {
      node.on(event, handler)
    },

    off(event, handler) {
      node.off(event, handler)
    },

    async shutdown(): Promise<void> {
      return node.shutdown()
    },

    registerEmbeddingAdapter: () => unsupported('registerEmbeddingAdapter'),
    listIndexes: () => unsupported('listIndexes'),
    getStats: () => unsupported('getStats'),
    getPartitionStats: () => unsupported('getPartitionStats'),
    rebuildAnalysis: () => unsupported('rebuildAnalysis'),
    snapshot: () => unsupported('snapshot'),
    restore: () => unsupported('restore'),
    rebalance: () => unsupported('rebalance'),
    updatePartitionConfig: () => unsupported('updatePartitionConfig'),
    compactVectors: () => unsupported('compactVectors'),
    optimizeVectors: () => unsupported('optimizeVectors'),
    vectorMaintenanceStatus: () => unsupported('vectorMaintenanceStatus'),
  }
}
