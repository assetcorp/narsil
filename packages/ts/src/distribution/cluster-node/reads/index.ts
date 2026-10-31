import { getNestedValue } from '../../../core/partition/utils'
import { applyProjection, type ResolvedProjection, resolveProjection } from '../../../core/projection'
import { runtimeHost } from '../../../engine/query/runtime-host'
import { ErrorCodes, NarsilError } from '../../../errors'
import { engineCoreOf } from '../../../narsil/internals'
import { queryBindingOf } from '../../../search/cursor-binding'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { AllocationTable } from '../../coordinator/types'
import { distributedQuery } from '../../query/routing'
import type { DistributedQueryConfig } from '../../query/types'
import { readDistributedDocuments } from '../node-messaging'
import { distributedCountIsExact, distributedResultToLocal, localParamsToWire } from '../query-conversion'
import { routableAllocation } from '../routable-allocation'
import type { ClusterQueryConfig } from '../types'
import { assembleDistributedGroups } from './groups'
import { countStoredPinsFromOutside, dropUnstoredPinnedEntries, readPinPresence } from './pinned'
import { createRankedDocumentReader, type RankedDocumentReader } from './ranked-documents'
import type { ClusterRerankHost } from './rerank'
import type { ClusterReadDeps } from './scatter'

export { countCluster, partitionStatsCluster, statsCluster } from './counts'
export { listIndexesCluster } from './index-list'
export { listCluster } from './list'
export type { ClusterReadDeps } from './scatter'
export { preflightCluster, suggestCluster } from './terms'

const clusterRerankHost: ClusterRerankHost = {
  ...runtimeHost,
  engineCoreOf,
  queryBindingOf,
  getNestedValue,
  applyProjection,
}

/**
 * Reads a set of documents by id from wherever the cluster holds them, and returns the ones it found.
 *
 * The node sends each id to the node that serves its partition, and it reads its own copy only for an index the
 * coordinator holds no metadata for.
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
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
  if (allocation === null) {
    return deps.engine.getMultiple(indexName, docIds)
  }
  return readDistributedDocuments(deps.config, deps.nodeId, deps.engine, indexName, docIds, allocation)
}

function routingConfig(
  query: ClusterQueryConfig | undefined,
  searchContexts: boolean,
): Partial<DistributedQueryConfig> {
  const config: Partial<DistributedQueryConfig> = { searchContexts }
  if (query?.allowPartialResults !== undefined) {
    config.allowPartialResults = query.allowPartialResults
  }
  if (query?.partitionTimeout !== undefined) {
    config.partitionTimeout = query.partitionTimeout
  }
  return config
}

function fetchFieldsFor(projection: ResolvedProjection): string[] | null {
  if (projection.kind !== 'fields' || projection.include === null) return null
  return projection.include.map(path => path.join('.'))
}

async function rerunOnLostContext<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof NarsilError) || error.code !== ErrorCodes.SEARCH_CONTEXT_MISSING) throw error
    return run()
  }
}

async function withRankedReader<T>(
  deps: ClusterReadDeps,
  indexName: string,
  allocation: AllocationTable,
  run: (reader: RankedDocumentReader) => Promise<T>,
): Promise<T> {
  const reader = createRankedDocumentReader(deps, indexName, allocation)
  try {
    return await run(reader)
  } finally {
    reader.release()
  }
}

/**
 * Runs a search across the cluster and returns the hits alongside the partition coverage behind them.
 *
 * The search reads each partition from one copy that the allocation table lists, and it asks the next in-sync copy
 * when that copy fails, times out, or cannot be reached. It counts a partition as failed only once every copy of it
 * has failed, so that a caller reading `coverage` can tell an incomplete answer from a complete one. A node
 * configured with `allowPartialResults` set to false refuses that answer with `QUERY_PARTIAL_FAILURE`.
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
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
  if (allocation === null) {
    return deps.engine.query<T>(indexName, params)
  }
  return rerunOnLostContext(async () => {
    if (params.rerank === undefined) {
      return withRankedReader(deps, indexName, allocation, reader =>
        searchCluster<T>(deps, indexName, params, allocation, reader, false),
      )
    }
    const { rerankClusterQuery } = await import('./rerank')
    return withRankedReader(deps, indexName, allocation, reader =>
      rerankClusterQuery<T>(
        deps,
        indexName,
        params,
        firstStage => searchCluster<T>(deps, indexName, firstStage, allocation, reader, true),
        (docIds, last) => reader.read(docIds, { last, fields: null, requireEveryPartition: true }),
        clusterRerankHost,
      ),
    )
  })
}

async function searchCluster<T>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  allocation: AllocationTable,
  reader: RankedDocumentReader,
  readsLater: boolean,
): Promise<QueryResult<T>> {
  const projection = resolveProjection(params.document)
  const groupsRead = params.group !== undefined && (params.group.reduce !== undefined || projection.kind !== 'none')
  const readsDocuments = readsLater || projection.kind !== 'none' || groupsRead
  const wireParams = localParamsToWire(params)
  const queryDeps = {
    transport: deps.config.transport,
    sourceNodeId: deps.nodeId,
    getAllocation: (idx: string) => deps.config.coordinator.getAllocation(idx),
    resolveNodeTargets: deps.resolveNodeTargets,
    listNodes: () => deps.config.coordinator.listNodes(),
  }
  const distributed = await distributedQuery(
    indexName,
    wireParams,
    queryDeps,
    routingConfig(deps.config.query, readsDocuments),
  )
  reader.adopt(distributed.contexts)
  const documents = new Map<string, T>()
  if (projection.kind !== 'none') {
    const found = await reader.read(
      distributed.scored.map(entry => entry.docId),
      { last: !groupsRead && !readsLater, fields: fetchFieldsFor(projection), requireEveryPartition: false },
    )
    for (const [docId, document] of found) documents.set(docId, applyProjection(document, projection) as T)
  }
  const pinPresence = await readPinPresence(deps, indexName, params, allocation)
  const scored = dropUnstoredPinnedEntries(distributed, pinPresence)
  const pins = countStoredPinsFromOutside(distributed, pinPresence)
  let countExact = distributedCountIsExact(params, distributed.coverage)
  let totalHits = distributed.totalHits
  if (distributed.mergeHeldEveryMatch === true && pins.everyPinVerified) {
    totalHits += pins.stored
  } else if (pins.stored > 0 || !pins.everyPinVerified) {
    countExact = false
  }
  const result = distributedResultToLocal<T>(
    { ...distributed, scored, totalHits },
    countExact,
    documents,
    params.facets,
  )
  const groups = await assembleDistributedGroups(params, distributed, projection, (docIds, last) =>
    reader.read(docIds, { last: last && !readsLater, fields: null, requireEveryPartition: true }),
  )
  if (groups !== undefined) {
    result.groups = groups
  }
  return result
}
