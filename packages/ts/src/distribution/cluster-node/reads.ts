import { resolveProjection } from '../../core/projection'
import type { QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { distributedQuery } from '../query/routing'
import type { ClusterLocalEngine } from './local-engine'
import { fetchDistributedDocuments, readDistributedDocuments } from './node-messaging'
import { distributedResultToLocal, localParamsToWire } from './query-conversion'
import type { ClusterNodeConfig } from './types'

export interface ClusterReadDeps {
  config: ClusterNodeConfig
  nodeId: string
  engine: ClusterLocalEngine
  resolveNodeTargets: (targetNodeId: string) => Promise<string[]>
}

async function activeAllocation(deps: ClusterReadDeps, indexName: string) {
  const allocation = await deps.config.coordinator.getAllocation(indexName)
  if (allocation === null || allocation.assignments.size === 0) {
    return null
  }
  for (const [, assignment] of allocation.assignments) {
    if (assignment.state === 'ACTIVE') {
      return allocation
    }
  }
  return null
}

export async function readClusterDocuments(
  deps: ClusterReadDeps,
  indexName: string,
  docIds: string[],
): Promise<Map<string, AnyDocument>> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.getMultiple(indexName, docIds)
  }
  return readDistributedDocuments(deps.config, deps.nodeId, deps.engine, indexName, docIds, allocation)
}

export async function queryCluster<T = AnyDocument>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
): Promise<QueryResult<T>> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.query<T>(indexName, params)
  }
  const wireParams = localParamsToWire(params)
  const queryDeps = {
    transport: deps.config.transport,
    sourceNodeId: deps.nodeId,
    getAllocation: (idx: string) => deps.config.coordinator.getAllocation(idx),
    resolveNodeTargets: deps.resolveNodeTargets,
  }
  const distributed = await distributedQuery(indexName, wireParams, queryDeps)
  const documents = await fetchDistributedDocuments<T>(
    deps.config,
    deps.nodeId,
    deps.engine,
    indexName,
    distributed,
    allocation,
    resolveProjection(params.document),
  )
  return distributedResultToLocal<T>(distributed, documents)
}
