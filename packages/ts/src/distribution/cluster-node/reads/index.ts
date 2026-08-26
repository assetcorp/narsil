import { resolveProjection } from '../../../core/projection'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { AllocationTable } from '../../coordinator/types'
import { distributedQuery } from '../../query/routing'
import { DEFAULT_QUERY_CONFIG, type DistributedQueryConfig } from '../../query/types'
import { fetchDistributedDocuments, readDistributedDocuments } from '../node-messaging'
import { distributedResultToLocal, localParamsToWire } from '../query-conversion'
import type { ClusterQueryConfig } from '../types'
import { activeAllocation, type ClusterReadDeps, servesAnyPartition } from './scatter'

export { countCluster, partitionStatsCluster, statsCluster } from './counts'
export { listCluster } from './list'
export type { ClusterReadDeps } from './scatter'
export { activeAllocation } from './scatter'
export { preflightCluster, suggestCluster } from './terms'

/**
 * Reads a set of documents by id from wherever the cluster holds them, and returns the ones it found.
 *
 * The node reads its own copy while the cluster has no active allocation for the index, which is what an index that
 * nobody has allocated yet looks like. It otherwise sends each id to the node that serves its partition.
 *
 * @param deps - The cluster configuration, this node's id, the local engine, and the node target resolver.
 * @param indexName - The index the documents are stored in.
 * @param docIds - The ids to read.
 * @returns The documents that were found, by id, which omits an id no node holds.
 */
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

function allowsPartialResults(deps: ClusterReadDeps): boolean {
  return deps.config.query?.allowPartialResults ?? DEFAULT_QUERY_CONFIG.allowPartialResults
}

async function queryLocalCopy<T>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  allocation: AllocationTable | null,
): Promise<QueryResult<T>> {
  if (allocation === null || allocation.assignments.size === 0) {
    return deps.engine.query<T>(indexName, params)
  }

  const totalPartitions = allocation.assignments.size
  if (!allowsPartialResults(deps)) {
    throw new NarsilError(
      ErrorCodes.QUERY_PARTIAL_FAILURE,
      `No active copy serves any partition of index '${indexName}', and this node refuses partial results`,
      { indexName, totalPartitions },
    )
  }

  const result = await deps.engine.query<T>(indexName, params)
  return {
    ...result,
    coverage: { totalPartitions, queriedPartitions: 0, timedOutPartitions: 0, failedPartitions: totalPartitions },
  }
}

/**
 * Runs a search across the cluster and returns the hits alongside the partition coverage behind them.
 *
 * Where no partition of the index has an active copy, the node answers from its own copy and reports every partition
 * as failed, so that a caller reading `coverage` can tell an incomplete answer from a complete one. A node configured
 * with `allowPartialResults` set to false refuses that answer with `QUERY_PARTIAL_FAILURE` instead.
 *
 * @param deps - The cluster configuration, this node's id, the local engine, and the node target resolver.
 * @param indexName - The index to search.
 * @param params - The query to run.
 * @returns The merged hits, the facets, the cursor, and the coverage.
 * @throws A {@link NarsilError} carrying `QUERY_PARTIAL_FAILURE` where a partition went unread and this node refuses
 * partial results.
 */
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
