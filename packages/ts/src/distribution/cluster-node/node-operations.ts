import type { QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { ClusterCoordinator } from '../coordinator/types'
import { replaceClusterBm25 } from './bm25-change'
import { clearCluster } from './clear'
import { awaitDropAcknowledgement, awaitTornDownCopy } from './drop-acknowledgement'
import { refuseHiddenGeneration } from './generation-routing'
import type { ClusterLocalEngine } from './local-engine'
import {
  type ClusterReadDeps,
  countCluster,
  listCluster,
  listIndexesCluster,
  partitionStatsCluster,
  preflightCluster,
  queryCluster,
  readClusterDocuments,
  statsCluster,
  suggestCluster,
} from './reads'
import { rebuildClusterAnalysis } from './rebuild-analysis'
import { dropServedIndex } from './reshard/drop'
import type { RebalanceJob } from './reshard/request'
import { readClusterSynonyms, replaceClusterSynonyms } from './synonym-sets'

import type { ClusterNode, CreateIndexOptions } from './types'
import {
  routeCreateIndex,
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
  | 'updateSynonyms'
  | 'getSynonyms'
  | 'updateBM25'
  | 'clear'
  | 'countDocuments'
  | 'listDocuments'
  | 'suggest'
  | 'preflight'
  | 'listIndexes'
  | 'rebuildAnalysis'
  | 'rebalance'
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
  servingName: (indexName: string) => Promise<string>
  requestRebalance: (indexName: string, targetPartitionCount: number) => Promise<RebalanceJob>
  waitForRebalance: (indexName: string, job: RebalanceJob) => Promise<void>
  readDeps: ClusterReadDeps
  writeDeps: WriteRoutingDeps
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  forgetIndex: (indexName: string) => void
  isOrphaned: (indexName: string) => boolean
}

export function createClusterNodeOperations(deps: ClusterNodeOperationDeps): ClusterNodeOperations {
  const { trackOp, readDeps, writeDeps, engine, coordinator } = deps

  function served<T>(indexName: string, fn: (servingName: string) => Promise<T>): Promise<T> {
    return trackOp(indexName, async () => fn(await deps.servingName(indexName)))
  }

  return {
    async createIndex(name, indexConfig, options?: CreateIndexOptions) {
      refuseHiddenGeneration(name)
      return trackOp(name, async () => {
        if (!deps.isOrphaned(name)) await awaitTornDownCopy(engine, coordinator, name)
        await routeCreateIndex(name, indexConfig, options, coordinator, engine)
      })
    },

    async insert(indexName, document, docId?, options?) {
      return served(indexName, name => routeInsert(name, document, docId, writeDeps, options))
    },

    async insertBatch(indexName, documents, options?) {
      return served(indexName, name => routeInsertBatch(name, documents, writeDeps, options))
    },

    async remove(indexName, docId) {
      return served(indexName, name => routeRemove(name, docId, writeDeps))
    },

    async removeBatch(indexName, docIds) {
      return served(indexName, name => routeRemoveBatch(name, docIds, writeDeps))
    },

    async update(indexName, docId, document) {
      return served(indexName, name => routeUpdate(name, docId, document, writeDeps))
    },

    async updateBatch(indexName, updates) {
      return served(indexName, name => routeUpdateBatch(name, updates, writeDeps))
    },

    async dropIndex(name) {
      refuseHiddenGeneration(name)
      return deps.transitionIndex(name, async () => {
        const dropped = await dropServedIndex(name, coordinator, engine)
        deps.forgetIndex(name)
        if (dropped !== null) {
          const acknowledgement = { config: readDeps.config, nodeId: readDeps.nodeId, engine, coordinator }
          await awaitDropAcknowledgement(acknowledgement, name, dropped.indexUuid)
        }
      })
    },

    async updateSynonyms(indexName, synonyms) {
      return trackOp(indexName, () =>
        replaceClusterSynonyms(
          { config: readDeps.config, nodeId: readDeps.nodeId, engine, coordinator },
          indexName,
          synonyms,
        ),
      )
    },

    async getSynonyms(indexName) {
      return trackOp(indexName, () => readClusterSynonyms(coordinator, indexName))
    },

    async updateBM25(indexName, bm25) {
      refuseHiddenGeneration(indexName)
      return trackOp(indexName, () => replaceClusterBm25(coordinator, readDeps.bm25View, indexName, bm25))
    },

    async clear(indexName) {
      return served(indexName, name => clearCluster(readDeps, writeDeps, name))
    },

    async countDocuments(indexName) {
      return served(indexName, name => countCluster(readDeps, name))
    },

    async listDocuments(indexName, params?) {
      return served(indexName, name => listCluster(readDeps, name, params ?? {}))
    },

    async suggest(indexName, params) {
      return served(indexName, name => suggestCluster(readDeps, name, params))
    },

    async preflight(indexName, params) {
      return served(indexName, name => preflightCluster({ ...readDeps, publicIndexName: indexName }, name, params))
    },

    async rebuildAnalysis(indexName) {
      return served(indexName, name =>
        rebuildClusterAnalysis({ nodeId: readDeps.nodeId, config: readDeps.config, engine }, name),
      )
    },

    async rebalance(indexName, targetPartitionCount) {
      const job = await trackOp(indexName, () => deps.requestRebalance(indexName, targetPartitionCount))
      return trackOp(null, () => deps.waitForRebalance(indexName, job))
    },

    async listIndexes() {
      return trackOp(null, () => listIndexesCluster(readDeps))
    },

    async getStats(indexName) {
      return served(indexName, name => statsCluster(readDeps, name))
    },

    async getPartitionStats(indexName) {
      return served(indexName, name => partitionStatsCluster(readDeps, name))
    },

    async checkpoint(indexName) {
      return served(indexName, name => engine.checkpoint(name))
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
      return served(indexName, name => queryCluster<T>({ ...readDeps, publicIndexName: indexName }, name, params))
    },

    async get(indexName, docId) {
      return served(indexName, async name => (await readClusterDocuments(readDeps, name, [docId])).get(docId))
    },

    async getMultiple(indexName, docIds) {
      return served(indexName, name => readClusterDocuments(readDeps, name, docIds))
    },

    async has(indexName, docId) {
      return served(indexName, async name => (await readClusterDocuments(readDeps, name, [docId])).has(docId))
    },
  }
}
