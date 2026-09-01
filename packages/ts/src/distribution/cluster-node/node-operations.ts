import type { QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { ClusterCoordinator } from '../coordinator/types'
import { clearCluster } from './clear'
import type { ClusterLocalEngine } from './local-engine'
import {
  type ClusterReadDeps,
  countCluster,
  listCluster,
  partitionStatsCluster,
  preflightCluster,
  queryCluster,
  readClusterDocuments,
  statsCluster,
  suggestCluster,
} from './reads'
import type { ClusterNode, CreateIndexOptions } from './types'
import {
  routeCreateIndex,
  routeDropIndex,
  routeInsert,
  routeInsertBatch,
  routeRemove,
  routeRemoveBatch,
  routeUpdate,
  routeUpdateBatch,
  type WriteRoutingDeps,
} from './write-routing'

export type ClusterNodeOperations = Pick<
  ClusterNode,
  | 'createIndex'
  | 'insert'
  | 'insertBatch'
  | 'remove'
  | 'removeBatch'
  | 'update'
  | 'updateBatch'
  | 'dropIndex'
  | 'clear'
  | 'countDocuments'
  | 'listDocuments'
  | 'suggest'
  | 'preflight'
  | 'getStats'
  | 'getPartitionStats'
  | 'checkpoint'
  | 'getMemoryStats'
  | 'on'
  | 'off'
  | 'query'
  | 'get'
  | 'getMultiple'
  | 'has'
>

export interface ClusterNodeOperationDeps {
  trackOp: <T>(indexName: string | null, fn: () => Promise<T>) => Promise<T>
  transitionIndex: <T>(indexName: string, fn: () => Promise<T>) => Promise<T>
  readDeps: ClusterReadDeps
  writeDeps: WriteRoutingDeps
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  forgetIndex: (indexName: string) => void
}

export function createClusterNodeOperations(deps: ClusterNodeOperationDeps): ClusterNodeOperations {
  const { trackOp, readDeps, writeDeps, engine, coordinator } = deps

  return {
    async createIndex(name, indexConfig, options?: CreateIndexOptions) {
      return trackOp(name, () => routeCreateIndex(name, indexConfig, options, coordinator, engine))
    },

    async insert(indexName, document, docId?, options?) {
      return trackOp(indexName, () => routeInsert(indexName, document, docId, writeDeps, options))
    },

    async insertBatch(indexName, documents, options?) {
      return trackOp(indexName, () => routeInsertBatch(indexName, documents, writeDeps, options))
    },

    async remove(indexName, docId) {
      return trackOp(indexName, () => routeRemove(indexName, docId, writeDeps))
    },

    async removeBatch(indexName, docIds) {
      return trackOp(indexName, () => routeRemoveBatch(indexName, docIds, writeDeps))
    },

    async update(indexName, docId, document) {
      return trackOp(indexName, () => routeUpdate(indexName, docId, document, writeDeps))
    },

    async updateBatch(indexName, updates) {
      return trackOp(indexName, () => routeUpdateBatch(indexName, updates, writeDeps))
    },

    async dropIndex(name) {
      return deps.transitionIndex(name, async () => {
        await routeDropIndex(name, coordinator, engine)
        deps.forgetIndex(name)
      })
    },

    async clear(indexName) {
      return trackOp(indexName, () => clearCluster(readDeps, writeDeps, indexName))
    },

    async countDocuments(indexName) {
      return trackOp(indexName, () => countCluster(readDeps, indexName))
    },

    async listDocuments(indexName, params?) {
      return trackOp(indexName, () => listCluster(readDeps, indexName, params ?? {}))
    },

    async suggest(indexName, params) {
      return trackOp(indexName, () => suggestCluster(readDeps, indexName, params))
    },

    async preflight(indexName, params) {
      return trackOp(indexName, () => preflightCluster(readDeps, indexName, params))
    },

    async getStats(indexName) {
      return trackOp(indexName, () => statsCluster(readDeps, indexName))
    },

    async getPartitionStats(indexName) {
      return trackOp(indexName, () => partitionStatsCluster(readDeps, indexName))
    },

    async checkpoint(indexName) {
      return trackOp(indexName, () => engine.checkpoint(indexName))
    },

    async getMemoryStats() {
      return trackOp(null, () => engine.getMemoryStats())
    },

    on(event, handler) {
      engine.on(event, handler)
    },

    off(event, handler) {
      engine.off(event, handler)
    },

    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      return trackOp(indexName, () => queryCluster<T>(readDeps, indexName, params))
    },

    async get(indexName, docId) {
      return trackOp(indexName, async () => (await readClusterDocuments(readDeps, indexName, [docId])).get(docId))
    },

    async getMultiple(indexName, docIds) {
      return trackOp(indexName, () => readClusterDocuments(readDeps, indexName, docIds))
    },

    async has(indexName, docId) {
      return trackOp(indexName, async () => (await readClusterDocuments(readDeps, indexName, [docId])).has(docId))
    },
  }
}
