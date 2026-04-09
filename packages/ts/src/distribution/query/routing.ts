import { decode } from '@msgpack/msgpack'
import { NarsilError } from '../../errors'
import { mergePartitionStats } from '../../partitioning/distributed-scoring'
import type { AllocationTable } from '../coordinator/types'
import type {
  FacetBucket,
  GlobalStatistics,
  NodeTransport,
  ScoredEntry,
  SearchResultPayload,
  StatsResultPayload,
  TransportMessage,
  WireQueryParams,
} from '../transport/types'
import { TransportError } from '../transport/types'
import {
  createSearchMessage,
  createStatsMessage,
  validateSearchResultPayload,
  validateStatsResultPayload,
} from './codec'
import { mergeAndTruncateScoredEntries, mergeDistributedFacets } from './merge'
import type { ReplicaSelector } from './selection'
import { hashBasedSelector, selectReplicasForQuery } from './selection'
import type { Coverage, DistributedQueryConfig, DistributedQueryResult } from './types'
import { DEFAULT_QUERY_CONFIG } from './types'

export interface QueryRoutingDeps {
  transport: NodeTransport
  sourceNodeId: string
  getAllocation: (indexName: string) => Promise<AllocationTable | null>
}

interface NodeQueryOutcome {
  nodeId: string
  partitionIds: number[]
  status: 'success' | 'timeout' | 'failed'
  results: SearchResultPayload | null
}

const MAX_QUERY_LIMIT = 10_000

export async function distributedQuery(
  indexName: string,
  params: WireQueryParams,
  deps: QueryRoutingDeps,
  config?: Partial<DistributedQueryConfig>,
  selector?: ReplicaSelector,
): Promise<DistributedQueryResult> {
  const resolvedConfig: DistributedQueryConfig = {
    ...DEFAULT_QUERY_CONFIG,
    ...config,
  }

  const limit = Math.min(Math.max(params.limit, 0), MAX_QUERY_LIMIT)

  const allocationTable = await deps.getAllocation(indexName)
  if (allocationTable === null) {
    throw new NarsilError('QUERY_ROUTING_FAILED', `No allocation table found for index '${indexName}'`, { indexName })
  }

  if (allocationTable.assignments.size === 0) {
    return {
      scored: [],
      totalHits: 0,
      facets: null,
      coverage: { totalPartitions: 0, queriedPartitions: 0, timedOutPartitions: 0, failedPartitions: 0 },
    }
  }

  const routing = selectReplicasForQuery(allocationTable, deps.sourceNodeId, selector ?? hashBasedSelector)
  const totalPartitions = allocationTable.assignments.size

  if (routing.unavailablePartitions.length > 0 && !resolvedConfig.allowPartialResults) {
    throw new NarsilError('QUERY_NO_ACTIVE_REPLICA', 'No active replica for one or more partitions', {
      unavailablePartitions: routing.unavailablePartitions,
    })
  }

  let globalStats: GlobalStatistics | null = null
  if (params.scoring === 'dfs') {
    globalStats = await collectDistributedStats(indexName, params, routing.nodeToPartitions, deps, resolvedConfig)
  }

  const searchParams: WireQueryParams = globalStats !== null ? { ...params } : params

  const outcomes = await fanOutSearch(
    indexName,
    searchParams,
    globalStats,
    routing.nodeToPartitions,
    deps,
    resolvedConfig,
  )

  const coverage = buildCoverage(totalPartitions, routing.unavailablePartitions.length, outcomes)

  if (!resolvedConfig.allowPartialResults) {
    const failedCount = coverage.timedOutPartitions + coverage.failedPartitions
    if (failedCount > 0) {
      throw new NarsilError('QUERY_PARTIAL_FAILURE', 'One or more partitions failed during query', {
        coverage,
      })
    }
  }

  const allScored: ScoredEntry[][] = []
  const allFacets: Array<Record<string, FacetBucket[]>> = []
  let totalHits = 0

  for (const outcome of outcomes) {
    if (outcome.status !== 'success' || outcome.results === null) {
      continue
    }

    for (const partitionResult of outcome.results.results) {
      totalHits += partitionResult.totalHits
      if (partitionResult.scored.length > 0) {
        allScored.push(partitionResult.scored)
      }
    }

    if (outcome.results.facets !== null) {
      allFacets.push(outcome.results.facets)
    }
  }

  const mergedScored = mergeAndTruncateScoredEntries(allScored, limit)
  const mergedFacets = allFacets.length > 0 ? mergeDistributedFacets(allFacets) : null

  return {
    scored: mergedScored,
    totalHits,
    facets: mergedFacets,
    coverage,
  }
}

async function collectDistributedStats(
  indexName: string,
  params: WireQueryParams,
  nodeToPartitions: Map<string, number[]>,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<GlobalStatistics> {
  const terms = params.term !== null ? params.term.split(/\s+/).filter(t => t.length > 0) : []
  const statsPromises: Array<Promise<StatsResultPayload | null>> = []
  const nodeEntries = Array.from(nodeToPartitions.entries())

  for (const [nodeId, partitionIds] of nodeEntries) {
    const message = createStatsMessage({ indexName, partitionIds, terms }, deps.sourceNodeId)
    const promise = sendWithTimeout<StatsResultPayload>(
      deps.transport,
      nodeId,
      message,
      config.partitionTimeout,
      validateStatsResultPayload,
    )
    statsPromises.push(promise)
  }

  const results = await Promise.allSettled(statsPromises)
  const validStats: Array<{
    totalDocuments: number
    docFrequencies: Record<string, number>
    totalFieldLengths: Record<string, number>
  }> = []

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      validStats.push(result.value)
    }
  }

  if (validStats.length === 0) {
    throw new NarsilError('QUERY_NODE_TIMEOUT', 'All partition stats requests failed during DFS pre-pass', {
      nodeCount: nodeEntries.length,
    })
  }

  return mergePartitionStats(validStats)
}

async function fanOutSearch(
  indexName: string,
  params: WireQueryParams,
  globalStats: GlobalStatistics | null,
  nodeToPartitions: Map<string, number[]>,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<NodeQueryOutcome[]> {
  const nodeEntries = Array.from(nodeToPartitions.entries())
  const promises: Array<Promise<NodeQueryOutcome>> = []

  for (const [nodeId, partitionIds] of nodeEntries) {
    const message = createSearchMessage({ indexName, partitionIds, params, globalStats }, deps.sourceNodeId)

    const promise = sendWithTimeout<SearchResultPayload>(
      deps.transport,
      nodeId,
      message,
      config.partitionTimeout,
      validateSearchResultPayload,
    ).then(
      (result): NodeQueryOutcome => ({
        nodeId,
        partitionIds,
        status: result !== null ? 'success' : 'timeout',
        results: result,
      }),
      (error): NodeQueryOutcome => ({
        nodeId,
        partitionIds,
        status: isTimeoutError(error) ? 'timeout' : 'failed',
        results: null,
      }),
    )

    promises.push(promise)
  }

  return Promise.all(promises)
}

async function sendWithTimeout<T>(
  transport: NodeTransport,
  target: string,
  message: TransportMessage,
  timeout: number,
  validate: (decoded: unknown) => T,
): Promise<T | null> {
  let timerId: ReturnType<typeof setTimeout> | undefined
  const abortPromise = new Promise<null>(resolve => {
    timerId = setTimeout(() => resolve(null), timeout)
    if (typeof timerId === 'object' && 'unref' in timerId) {
      ;(timerId as { unref: () => void }).unref()
    }
  })

  const sendPromise = transport.send(target, message).then(response => {
    const decoded = decode(response.payload)
    return validate(decoded)
  })

  try {
    return await Promise.race([sendPromise, abortPromise])
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId)
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof TransportError && error.code === 'TRANSPORT_TIMEOUT'
}

function buildCoverage(totalPartitions: number, unavailableCount: number, outcomes: NodeQueryOutcome[]): Coverage {
  let queriedPartitions = 0
  let timedOutPartitions = 0
  let failedPartitions = unavailableCount

  for (const outcome of outcomes) {
    const partitionCount = outcome.partitionIds.length
    switch (outcome.status) {
      case 'success':
        queriedPartitions += partitionCount
        break
      case 'timeout':
        timedOutPartitions += partitionCount
        break
      case 'failed':
        failedPartitions += partitionCount
        break
    }
  }

  return {
    totalPartitions,
    queriedPartitions,
    timedOutPartitions,
    failedPartitions,
  }
}
