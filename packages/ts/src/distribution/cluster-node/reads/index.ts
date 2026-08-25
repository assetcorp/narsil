import { resolveProjection } from '../../../core/projection'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { AllocationTable } from '../../coordinator/types'
import { distributedQuery } from '../../query/routing'
import type { DistributedQueryConfig } from '../../query/types'
import { fetchDistributedDocuments, readDistributedDocuments } from '../node-messaging'
import { distributedResultToLocal, localParamsToWire } from '../query-conversion'
import type { ClusterQueryConfig } from '../types'
import { activeAllocation, type ClusterReadDeps, servesAnyPartition } from './scatter'

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

function routingConfig(query: ClusterQueryConfig | undefined): Partial<DistributedQueryConfig> | undefined {
  if (query === undefined) {
    return undefined
  }
  const config: Partial<DistributedQueryConfig> = {}
  if (query.allowPartialResults !== undefined) {
    config.allowPartialResults = query.allowPartialResults
  }
  if (query.partitionTimeout !== undefined) {
    config.partitionTimeout = query.partitionTimeout
  }
  return config
}

async function queryLocalCopy<T>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  allocation: AllocationTable | null,
): Promise<QueryResult<T>> {
  const result = await deps.engine.query<T>(indexName, params)
  if (allocation === null || allocation.assignments.size === 0) {
    return result
  }
  const totalPartitions = allocation.assignments.size
  return {
    ...result,
    coverage: { totalPartitions, queriedPartitions: 0, timedOutPartitions: 0, failedPartitions: totalPartitions },
  }
}

export async function queryCluster<T = AnyDocument>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
): Promise<QueryResult<T>> {
  const table = await deps.config.coordinator.getAllocation(indexName)
  if (!servesAnyPartition(table)) {
    return queryLocalCopy<T>(deps, indexName, params, table)
  }
  const allocation = table
  const wireParams = localParamsToWire(params)
  const queryDeps = {
    transport: deps.config.transport,
    sourceNodeId: deps.nodeId,
    getAllocation: (idx: string) => deps.config.coordinator.getAllocation(idx),
    resolveNodeTargets: deps.resolveNodeTargets,
  }
  const distributed = await distributedQuery(indexName, wireParams, queryDeps, routingConfig(deps.config.query))
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
