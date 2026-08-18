import { resolveProjection } from '../../../core/projection'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { distributedQuery } from '../../query/routing'
import { fetchDistributedDocuments, readDistributedDocuments } from '../node-messaging'
import { distributedResultToLocal, localParamsToWire } from '../query-conversion'
import { activeAllocation, type ClusterReadDeps } from './scatter'

export { countCluster, partitionStatsCluster, statsCluster } from './counts'
export { listCluster } from './list'
export type { ClusterReadDeps } from './scatter'
export { activeAllocation } from './scatter'
export { preflightCluster, suggestCluster } from './terms'

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
