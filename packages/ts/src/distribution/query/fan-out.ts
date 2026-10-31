import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError, ServerErrorCodes } from '../../errors'
import { mergePartitionStats } from '../../partitioning/distributed-scoring'
import type { QueryCoverage } from '../../types/results'
import type {
  GlobalStatistics,
  NodeTransport,
  SearchResultPayload,
  StatsExpansionPayload,
  StatsPayload,
  StatsResultPayload,
  TransportMessage,
  WireQueryParams,
} from '../transport/types'
import {
  createSearchMessage,
  createStatsMessage,
  validateSearchResultPayload,
  validateStatsResultPayload,
} from './codec'
import { type CopyRouting, generationRefusalOf, isNodeRejection, nodeRejectionOf, sendWithFailover } from './failover'
import { resolveTargets, sendToFirstReachableTarget } from './node-send'
import { queryReadsPhrases } from './phrase-routing'
import { releaseSearchContexts } from './search-contexts'
import type { DistributedQueryConfig, QueryRoutingDeps } from './types'

export interface NodeQueryOutcome {
  nodeId: string
  partitionIds: number[]
  status: 'success' | 'timeout' | 'failed'
  results: SearchResultPayload | null
}

function queryRejectionOf(response: TransportMessage, decoded: unknown): NarsilError | null {
  const body = decoded as { error?: unknown; code?: unknown; message?: unknown; details?: unknown } | null
  if (!response.type.endsWith('.error') && body?.error !== true) return null
  const details =
    typeof body?.details === 'object' && body.details !== null ? { ...(body.details as Record<string, unknown>) } : {}
  const generationRefusal = generationRefusalOf(body?.code, body?.message, details)
  if (generationRefusal !== null) return generationRefusal
  if (body?.code !== ServerErrorCodes.TOO_MANY_REQUESTS) return nodeRejectionOf(body?.code, body?.message)
  return new NarsilError(
    ServerErrorCodes.TOO_MANY_REQUESTS,
    typeof body?.message === 'string' ? body.message : 'A node had no room in memory to answer its part of the search',
    details,
  )
}

function isMemoryRefusal(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ServerErrorCodes.TOO_MANY_REQUESTS
}

interface NodeStats {
  partitionIds: number[]
  result: StatsResultPayload
}

function statsExpansionOf(params: WireQueryParams): StatsExpansionPayload {
  return {
    tolerance: params.tolerance,
    prefixLength: params.prefixLength,
    prefix: params.prefix,
    partialWords: params.partialWords ?? null,
    exact: params.exact,
    fields: params.fields,
  }
}

async function requestStats(
  nodeId: string,
  payload: StatsPayload,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<StatsResultPayload | null> {
  const message = createStatsMessage(payload, deps.sourceNodeId)
  const targets = await resolveTargets(nodeId, deps)
  return sendWithTimeout<StatsResultPayload>(
    deps.transport,
    targets,
    message,
    config.partitionTimeout,
    validateStatsResultPayload,
  )
}

async function countLeftOutTokens(
  indexName: string,
  answered: Array<[string, NodeStats]>,
  analysisGeneration: number | undefined,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<StatsResultPayload[]> {
  const reached = new Set<string>()
  for (const [, { result }] of answered) {
    for (const token of result.expanded ?? []) reached.add(token)
  }
  if (reached.size === 0) return []
  const counts = await Promise.allSettled(
    answered.map(async ([nodeId, { partitionIds, result }]) => {
      const tokens = [...reached].filter(token => !Object.hasOwn(result.docFrequencies, token))
      if (tokens.length === 0) return null
      const counted = await requestStats(
        nodeId,
        { indexName, partitionIds, terms: [], tokens, analysisGeneration },
        deps,
        config,
      )
      if (counted === null) return null
      const docFrequencies: Record<string, number> = Object.create(null)
      for (const token of tokens) {
        if (Object.hasOwn(counted.docFrequencies, token)) docFrequencies[token] = counted.docFrequencies[token]
      }
      return { totalDocuments: 0, docFrequencies, totalFieldLengths: {} }
    }),
  )
  const extra: StatsResultPayload[] = []
  for (const count of counts) {
    if (count.status === 'fulfilled' && count.value !== null) extra.push(count.value)
  }
  return extra
}

export async function collectDistributedStats(
  indexName: string,
  params: WireQueryParams,
  routing: CopyRouting,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
): Promise<GlobalStatistics> {
  if (routing.nodeToPartitions.size === 0 && queryReadsPhrases(params.term)) return mergePartitionStats([])
  const terms = params.term !== null ? params.term.split(/\s+/).filter(t => t.length > 0) : []
  const expansion = statsExpansionOf(params)
  const { analysisGeneration } = params
  const outcomes = await sendWithFailover(routing, (nodeId, partitionIds) =>
    requestStats(nodeId, { indexName, partitionIds, terms, expansion, analysisGeneration }, deps, config),
  )
  const refused = outcomes.find(
    outcome =>
      isNodeRejection(outcome.error) &&
      outcome.error instanceof NarsilError &&
      outcome.error.code === ErrorCodes.ANALYSIS_GENERATION_MISSING,
  )
  if (refused !== undefined) throw refused.error

  const answered: Array<[string, NodeStats]> = []
  for (const outcome of outcomes) {
    if (outcome.status === 'success' && outcome.result !== null) {
      answered.push([outcome.nodeId, { partitionIds: outcome.partitionIds, result: outcome.result }])
    }
  }

  if (answered.length === 0) {
    throw new NarsilError(ErrorCodes.QUERY_NODE_TIMEOUT, 'All partition stats requests failed during DFS pre-pass', {
      nodeCount: routing.nodeToPartitions.size,
    })
  }

  const leftOut = await countLeftOutTokens(indexName, answered, analysisGeneration, deps, config)
  return mergePartitionStats([...answered.map(([, { result }]) => result), ...leftOut])
}

export async function fanOutSearch(
  indexName: string,
  params: WireQueryParams,
  globalStats: GlobalStatistics | null,
  facetShardSize: number | null,
  routing: CopyRouting,
  deps: QueryRoutingDeps,
  config: DistributedQueryConfig,
  keepAliveMs: number | null = null,
): Promise<NodeQueryOutcome[]> {
  const outcomes = await sendWithFailover(routing, async (nodeId, partitionIds) => {
    const message = createSearchMessage(
      {
        indexName,
        partitionIds,
        params,
        globalStats,
        facetShardSize,
        ...(keepAliveMs === null ? {} : { keepAliveMs }),
      },
      deps.sourceNodeId,
    )
    const targets = await resolveTargets(nodeId, deps)
    return sendWithTimeout<SearchResultPayload>(
      deps.transport,
      targets,
      message,
      config.partitionTimeout,
      validateSearchResultPayload,
      late => {
        if (typeof late.contextId === 'string') {
          releaseSearchContexts(indexName, [{ nodeId, contextId: late.contextId }], deps)
        }
      },
    )
  })

  const memoryRefusal = outcomes.find(outcome => isMemoryRefusal(outcome.error))
  const everyPartitionFailed = outcomes.every(outcome => outcome.status !== 'success')
  const rejection =
    outcomes.find(outcome => isNodeRejection(outcome.error)) ??
    (!config.allowPartialResults || everyPartitionFailed ? memoryRefusal : undefined)
  if (rejection !== undefined) {
    releaseSearchContexts(indexName, openedContextsOf(outcomes), deps)
    throw rejection.error
  }
  return outcomes.map(outcome => ({
    nodeId: outcome.nodeId,
    partitionIds: outcome.partitionIds,
    status: outcome.status,
    results: outcome.result,
  }))
}

function openedContextsOf(
  outcomes: ReadonlyArray<{ nodeId: string; result: SearchResultPayload | null }>,
): Array<{ nodeId: string; contextId: string }> {
  const opened: Array<{ nodeId: string; contextId: string }> = []
  for (const outcome of outcomes) {
    const contextId = outcome.result?.contextId
    if (typeof contextId === 'string') opened.push({ nodeId: outcome.nodeId, contextId })
  }
  return opened
}

const OUTCOME_SEVERITY: Record<NodeQueryOutcome['status'], number> = { success: 0, timeout: 1, failed: 2 }

/**
 * Reports how much of an index one search read, counting each partition once however many fan-outs covered it.
 *
 * A hybrid query sends a text fan-out and a vector fan-out to the same nodes, and either leg may drop a partition the
 * other one read. This keeps the worse outcome for each partition, so that a partition one leg lost counts as lost
 * whatever the other leg returned, and the three counts add up to the partitions the query set out to read.
 *
 * @param totalPartitions - How many partitions the index holds.
 * @param unavailablePartitions - The partitions no active copy served, which count as failed.
 * @param outcomeSets - One array of node outcomes for each fan-out the query issued.
 * @returns The coverage to report alongside the hits.
 */
export function buildCoverage(
  totalPartitions: number,
  unavailablePartitions: number[],
  ...outcomeSets: NodeQueryOutcome[][]
): QueryCoverage {
  const worstByPartition = new Map<number, NodeQueryOutcome['status']>()

  for (const partitionId of unavailablePartitions) {
    worstByPartition.set(partitionId, 'failed')
  }

  for (const outcomes of outcomeSets) {
    for (const outcome of outcomes) {
      for (const partitionId of outcome.partitionIds) {
        const worstSoFar = worstByPartition.get(partitionId)
        if (worstSoFar === undefined || OUTCOME_SEVERITY[outcome.status] > OUTCOME_SEVERITY[worstSoFar]) {
          worstByPartition.set(partitionId, outcome.status)
        }
      }
    }
  }

  let queriedPartitions = 0
  let timedOutPartitions = 0
  let failedPartitions = 0

  for (const status of worstByPartition.values()) {
    if (status === 'success') {
      queriedPartitions += 1
    } else if (status === 'timeout') {
      timedOutPartitions += 1
    } else {
      failedPartitions += 1
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
  onLate?: (late: T) => void,
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
    const rejection = queryRejectionOf(response, decoded)
    if (rejection !== null) throw rejection
    return validate(decoded)
  })

  try {
    const answered = await Promise.race([sendPromise, abortPromise])
    if (answered === null && onLate !== undefined) sendPromise.then(onLate, () => undefined)
    return answered
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId)
    }
  }
}
