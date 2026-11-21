import { getNestedValue } from '../../../core/partition/utils'
import {
  applyProjection,
  type ResolvedProjection,
  resolveProjection,
  type VectorReadSettings,
} from '../../../core/projection'
import { runtimeHost } from '../../../engine/query/runtime-host'
import { ErrorCodes, NarsilError } from '../../../errors'
import { engineCoreOf } from '../../../narsil/internals'
import { queryBindingOf } from '../../../search/cursor-binding'
import type { GetOptions } from '../../../types/reads'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { AllocationTable } from '../../coordinator/types'
import { distributedQuery } from '../../query/routing'
import type { DistributedQueryConfig } from '../../query/types'
import { rerunOnNewerGeneration } from '../analysis-change/rerun'
import { readDocumentsFromCopies } from '../node-messaging'
import { distributedCountIsExact, distributedResultToLocal } from '../query-conversion'
import { routableAllocation } from '../routable-allocation'
import type { ClusterQueryConfig } from '../types'
import { bm25RoutingFor, heldBm25RoutingFor } from './bm25'
import { assembleDistributedGroups } from './groups'
import { countStoredPinsFromOutside, dropUnstoredPinnedEntries, readPinPresence } from './pinned'
import { createRankedDocumentReader, type RankedDocumentReader } from './ranked-documents'
import type { ClusterRerankHost } from './rerank'
import type { ClusterReadDeps } from './scatter'
import { keepsAnyVectorField } from './vector-reads'

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
 * @param options - The shape of each returned document, which leaves vector fields out unless it asks for them.
 * @returns The documents that were found, by id, which omits an id no node holds.
 */
export async function readClusterDocuments(
  deps: ClusterReadDeps,
  indexName: string,
  docIds: string[],
  options?: GetOptions,
): Promise<Map<string, AnyDocument>> {
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
  if (allocation === null) {
    return deps.engine.getMultiple(indexName, docIds, options)
  }
  const settings = await deps.vectorReads.settingsOf(indexName, allocation)
  const projection = resolveProjection(options?.document, settings)
  const found = await readDocumentsFromCopies(
    deps.config,
    deps.nodeId,
    deps.engine,
    indexName,
    docIds,
    allocation,
    { fields: fetchFieldsFor(projection), vectors: keepsAnyVectorField(projection, settings) },
    true,
  )
  if (projection.kind === 'full') return found
  const documents = new Map<string, AnyDocument>()
  for (const [docId, document] of found) documents.set(docId, applyProjection(document, projection))
  return documents
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
 * @param settingName - The name that the caller used, under which the index stores its BM25 setting.
 * @returns The merged hits, the facets, the cursor, and the coverage.
 * @throws A {@link NarsilError} carrying `QUERY_PARTIAL_FAILURE` where a partition went unread and this node refuses
 * partial results.
 */
export async function queryCluster<T = AnyDocument>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  settingName: string,
): Promise<QueryResult<T>> {
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
  if (allocation === null) {
    return deps.engine.query<T>(indexName, params)
  }
  return rerunOnNewerGeneration(deps.analysisView, indexName, () =>
    rerunOnLostContext(async () => {
      const settings = await deps.vectorReads.settingsOf(indexName, allocation)
      const search: ClusterSearch = { indexName, settingName, allocation, settings }
      if (params.rerank === undefined) {
        return withRankedReader(deps, indexName, allocation, reader =>
          searchCluster<T>(deps, search, params, reader, false),
        )
      }
      const { rerankClusterQuery } = await import('./rerank')
      return withRankedReader(deps, indexName, allocation, reader =>
        rerankClusterQuery<T>(
          deps,
          params,
          settings,
          firstStage => searchCluster<T>(deps, search, firstStage, reader, true),
          (docIds, last, vectors) => reader.read(docIds, { last, fields: null, vectors, requireEveryPartition: true }),
          clusterRerankHost,
        ),
      )
    }),
  )
}

interface ClusterSearch {
  indexName: string
  settingName: string
  allocation: AllocationTable
  settings: VectorReadSettings
}

async function searchCluster<T>(
  deps: ClusterReadDeps,
  search: ClusterSearch,
  params: QueryParams,
  reader: RankedDocumentReader,
  readsLater: boolean,
): Promise<QueryResult<T>> {
  const { indexName, settingName, allocation, settings } = search
  const projection = resolveProjection(params.document, settings)
  const vectors = keepsAnyVectorField(projection, settings)
  const groupsRead = params.group !== undefined && (params.group.reduce !== undefined || projection.kind !== 'none')
  const readsDocuments = readsLater || projection.kind !== 'none' || groupsRead
  const { wireParams, carriesBm25 } =
    heldBm25RoutingFor(deps, settingName, params) ?? (await bm25RoutingFor(deps, settingName, params))
  wireParams.analysisGeneration =
    deps.analysisView.held(indexName) ?? (await deps.analysisView.generationFor(indexName))
  const pinPresence = await readPinPresence(deps, indexName, params, allocation)
  const queryDeps = {
    transport: deps.config.transport,
    sourceNodeId: deps.nodeId,
    getAllocation: (idx: string) => deps.config.coordinator.getAllocation(idx),
    resolveNodeTargets: deps.resolveNodeTargets,
    listNodes: () => deps.config.coordinator.listNodes(),
    carriesBm25,
    pinnedDocuments: pinPresence === null ? undefined : new Set([...pinPresence.stored, ...pinPresence.unverifiable]),
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
      { last: !groupsRead && !readsLater, fields: fetchFieldsFor(projection), vectors, requireEveryPartition: false },
    )
    for (const [docId, document] of found) documents.set(docId, applyProjection(document, projection) as T)
  }
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
    reader.read(docIds, { last: last && !readsLater, fields: null, vectors, requireEveryPartition: true }),
  )
  if (groups !== undefined) {
    result.groups = groups
  }
  if (wireParams.sort !== null && wireParams.sort.length > 0 && params.includeScores !== true) {
    for (const hit of result.hits) hit.score = undefined
    for (const group of groups ?? []) for (const hit of group.hits) hit.score = undefined
  }
  return result
}
