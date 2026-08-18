import { compareCodePoints } from '../../../core/ordering'
import { DEFAULT_SUGGEST_LIMIT, MAX_SUGGEST_LIMIT } from '../../../engine/suggest'
import { clampRowCount } from '../../../search/pagination'
import type { PreflightResult, SuggestResult } from '../../../types/results'
import type { QueryParams, SuggestParams } from '../../../types/search'
import {
  createPreflightMessage,
  createSuggestMessage,
  validatePreflightResultPayload,
  validateSuggestResultPayload,
} from '../../query/codec'
import { localParamsToWire } from '../query-conversion'
import { activeAllocation, type ClusterReadDeps, sendReadRequest, strictScatterGroups } from './scatter'

const SUGGEST_OVERSAMPLE_FACTOR = 1.5
const SUGGEST_OVERSAMPLE_PADDING = 10

export async function suggestCluster(
  deps: ClusterReadDeps,
  indexName: string,
  params: SuggestParams,
): Promise<SuggestResult> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.suggest(indexName, params)
  }

  const startTime = performance.now()
  const clientLimit = Math.max(1, Math.min(clampRowCount(params.limit, DEFAULT_SUGGEST_LIMIT), MAX_SUGGEST_LIMIT))
  const prefix = params.prefix.trim()
  if (prefix.length === 0) {
    return { terms: [], elapsed: performance.now() - startTime }
  }

  const nodeLimit = Math.min(
    Math.ceil(clientLimit * SUGGEST_OVERSAMPLE_FACTOR) + SUGGEST_OVERSAMPLE_PADDING,
    MAX_SUGGEST_LIMIT,
  )
  const groups = strictScatterGroups(allocation, deps.nodeId, indexName)

  const gathered = await Promise.all(
    groups.map(async group => {
      if (group.nodeId === deps.nodeId) {
        const local = await deps.engine.suggestPartitions(indexName, { prefix, limit: nodeLimit }, group.partitionIds)
        return { terms: local.terms, analysisStale: local.analysisStale === true }
      }
      const message = createSuggestMessage(
        { indexName, partitionIds: group.partitionIds, prefix, limit: nodeLimit },
        deps.nodeId,
      )
      return sendReadRequest(deps, group.nodeId, message, indexName, validateSuggestResultPayload)
    }),
  )

  const mergedFrequencies = new Map<string, number>()
  let analysisStale = false
  for (const result of gathered) {
    analysisStale = analysisStale || result.analysisStale
    for (const entry of result.terms) {
      mergedFrequencies.set(entry.term, (mergedFrequencies.get(entry.term) ?? 0) + entry.documentFrequency)
    }
  }

  const terms = Array.from(mergedFrequencies.entries())
    .map(([term, documentFrequency]) => ({ term, documentFrequency }))
    .sort((a, b) => b.documentFrequency - a.documentFrequency || compareCodePoints(a.term, b.term))

  if (terms.length > clientLimit) {
    terms.length = clientLimit
  }

  const result: SuggestResult = { terms, elapsed: performance.now() - startTime }
  if (analysisStale) {
    result.analysisStale = true
  }
  return result
}

export async function preflightCluster(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
): Promise<PreflightResult> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.preflight(indexName, params)
  }

  const startTime = performance.now()
  const wireParams = localParamsToWire(params)
  const groups = strictScatterGroups(allocation, deps.nodeId, indexName)

  const gathered = await Promise.all(
    groups.map(async group => {
      if (group.nodeId === deps.nodeId) {
        const local = await deps.engine.preflightPartitions(indexName, params, group.partitionIds)
        return { count: local.count, analysisStale: local.analysisStale === true }
      }
      const message = createPreflightMessage(
        { indexName, partitionIds: group.partitionIds, params: wireParams },
        deps.nodeId,
      )
      return sendReadRequest(deps, group.nodeId, message, indexName, validatePreflightResultPayload)
    }),
  )

  let count = 0
  let analysisStale = false
  for (const result of gathered) {
    count += result.count
    analysisStale = analysisStale || result.analysisStale
  }

  const result: PreflightResult = { count, elapsed: performance.now() - startTime }
  if (analysisStale) {
    result.analysisStale = true
  }
  return result
}
