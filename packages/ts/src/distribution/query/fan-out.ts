import { decode } from '@msgpack/msgpack'
import { NarsilError } from '../../errors'
import { mergePartitionStats } from '../../partitioning/distributed-scoring'
import type {
  GlobalStatistics,
  NodeTransport,
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
import type { Coverage, DistributedQueryConfig, QueryRoutingDeps } from './types'

export interface NodeQueryOutcome {
  nodeId: string
  partitionIds: number[]
  status: 'success' | 'timeout' | 'failed'
  results: SearchResultPayload | null
}

export async function collectDistributedStats(
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
    const targets = await resolveTargets(nodeId, deps)
    const promise = sendWithTimeout<StatsResultPayload>(
      deps.transport,
      targets,
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

export async function fanOutSearch(
  indexName: string,
  params: WireQueryParams,
  globalStats: GlobalStatistics | null,
  facetShardSize: number | null,
  nodeToPartitions: Map<string, number[]>,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<NodeQueryOutcome[]> {
  const nodeEntries = Array.from(nodeToPartitions.entries())
  const promises: Array<Promise<NodeQueryOutcome>> = []

  for (const [nodeId, partitionIds] of nodeEntries) {
    const message = createSearchMessage(
      { indexName, partitionIds, params, globalStats, facetShardSize },
      deps.sourceNodeId,
    )
    const targets = await resolveTargets(nodeId, deps)

    const promise = sendWithTimeout<SearchResultPayload>(
      deps.transport,
      targets,
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

export function buildCoverage(
  totalPartitions: number,
  unavailableCount: number,
  outcomes: NodeQueryOutcome[],
): Coverage {
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

async function sendWithTimeout<T>(
  transport: NodeTransport,
  targets: string[],
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

  const sendPromise = sendToFirstReachableTarget(transport, targets, message).then(response => {
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

async function resolveTargets(nodeId: string, deps: QueryRoutingDeps): Promise<string[]> {
  if (deps.resolveNodeTargets === undefined) {
    return [nodeId]
  }
  const targets = await deps.resolveNodeTargets(nodeId)
  return targets.length > 0 ? targets : [nodeId]
}

async function sendToFirstReachableTarget(
  transport: NodeTransport,
  targets: string[],
  message: TransportMessage,
): Promise<TransportMessage> {
  let lastError: unknown
  for (const target of targets) {
    try {
      return await transport.send(target, message)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof TransportError && error.code === 'TRANSPORT_TIMEOUT'
}
