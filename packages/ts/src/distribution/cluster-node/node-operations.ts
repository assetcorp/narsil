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
  trackOp: <T>(fn: () => Promise<T>) => Promise<T>
  readDeps: ClusterReadDeps
  writeDeps: WriteRoutingDeps
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
}

export function createClusterNodeOperations(deps: ClusterNodeOperationDeps): ClusterNodeOperations {
  const { trackOp, readDeps, writeDeps, engine, coordinator } = deps

  return {
    async createIndex(name, indexConfig, options?: CreateIndexOptions) {
      return trackOp(() => routeCreateIndex(name, indexConfig, options, coordinator, engine))
    },

    async insert(indexName, document, docId?) {
      return trackOp(() => routeInsert(indexName, document, docId, writeDeps))
    },

    async insertBatch(indexName, documents) {
      return trackOp(() => routeInsertBatch(indexName, documents, writeDeps))
    },

    async remove(indexName, docId) {
      return trackOp(() => routeRemove(indexName, docId, writeDeps))
    },

    async removeBatch(indexName, docIds) {
      return trackOp(() => routeRemoveBatch(indexName, docIds, writeDeps))
    },

    async update(indexName, docId, document) {
      return trackOp(() => routeUpdate(indexName, docId, document, writeDeps))
    },

    async updateBatch(indexName, updates) {
      return trackOp(() => routeUpdateBatch(indexName, updates, writeDeps))
    },

    async dropIndex(name) {
      return trackOp(() => routeDropIndex(name, coordinator, engine))
    },

    async clear(indexName) {
      return trackOp(() => clearCluster(readDeps, writeDeps, indexName))
    },

    async countDocuments(indexName) {
      return trackOp(() => countCluster(readDeps, indexName))
    },

    async listDocuments(indexName, params?) {
      return trackOp(() => listCluster(readDeps, indexName, params ?? {}))
    },

    async suggest(indexName, params) {
      return trackOp(() => suggestCluster(readDeps, indexName, params))
    },

    async preflight(indexName, params) {
      return trackOp(() => preflightCluster(readDeps, indexName, params))
    },

    async getStats(indexName) {
      return trackOp(() => statsCluster(readDeps, indexName))
    },

    async getPartitionStats(indexName) {
      return trackOp(() => partitionStatsCluster(readDeps, indexName))
    },

    async checkpoint(indexName) {
      return trackOp(() => engine.checkpoint(indexName))
    },

    async getMemoryStats() {
      return trackOp(() => engine.getMemoryStats())
    },

    on(event, handler) {
      engine.on(event, handler)
    },

    off(event, handler) {
      engine.off(event, handler)
    },

    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      return trackOp(() => queryCluster<T>(readDeps, indexName, params))
    },

    async get(indexName, docId) {
      return trackOp(async () => (await readClusterDocuments(readDeps, indexName, [docId])).get(docId))
    },

    async getMultiple(indexName, docIds) {
      return trackOp(() => readClusterDocuments(readDeps, indexName, docIds))
    },

    async has(indexName, docId) {
      return trackOp(async () => (await readClusterDocuments(readDeps, indexName, [docId])).has(docId))
    },
  }
}
