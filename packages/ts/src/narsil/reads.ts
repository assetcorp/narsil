import type { EngineCore } from '../engine/core'
import { executeListDocuments } from '../engine/list-documents'
import { executePreflight, executeQuery } from '../engine/query'
import { resolveVectorText } from '../engine/resolve-vector-text'
import { executeSuggest } from '../engine/suggest'
import { collectQueryTermStats } from '../partitioning/distributed-scoring'
import { queryBindingOf } from '../search/cursor-binding'
import type { GlobalStatistics } from '../types/internal'
import type { ListResult, PreflightResult, QueryResult, SuggestResult } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../types/search'

export interface ScopedReadOptions {
  partitionIds?: number[]
  globalStats?: GlobalStatistics
}

function scopedParams(params: QueryParams, options: ScopedReadOptions | undefined): QueryParams {
  if (options?.globalStats === undefined) {
    return params
  }
  return { ...params, scoring: 'broadcast' }
}

function broadcastStatsFor(core: EngineCore, options: ScopedReadOptions | undefined) {
  const supplied = options?.globalStats
  if (supplied !== undefined) {
    return () => supplied
  }
  const invalidation = core.invalidation
  if (invalidation === null) {
    return undefined
  }
  return (name: string) => invalidation.broadcastStats(name)
}

export async function runEngineQuery<T = AnyDocument>(
  core: EngineCore,
  indexName: string,
  params: QueryParams,
  options?: ScopedReadOptions,
): Promise<QueryResult<T>> {
  core.guardShutdown()
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)

    const resolvedParams = await resolveVectorText(
      scopedParams(params, options),
      entry.embeddingAdapter,
      core.abortController.signal,
      entry.embeddingAdapterName,
    )

    await core.pluginRegistry.runHook('beforeSearch', { indexName, params: resolvedParams })

    const workerSearch = core.orchestrator.hasWorkerPool()
      ? core.orchestrator.searchViaWorker.bind(core.orchestrator)
      : undefined

    const result = await executeQuery<T>(resolvedParams, {
      manager,
      language: entry.language,
      config: entry.config,
      workerSearch,
      indexName,
      broadcastStats: broadcastStatsFor(core, options),
      partitionIds: options?.partitionIds,
      cursorBinding: queryBindingOf(params),
    })

    try {
      await core.pluginRegistry.runHook('afterSearch', {
        indexName,
        params: resolvedParams,
        results: result as unknown as QueryResult,
      })
    } catch (err) {
      console.warn('afterSearch plugin hook error:', err)
    }

    if (core.analysisRebuild.isStale(indexName)) {
      result.analysisStale = true
    }

    return result
  } finally {
    release()
  }
}

export async function runEnginePreflight(
  core: EngineCore,
  indexName: string,
  params: QueryParams,
  options?: ScopedReadOptions,
): Promise<PreflightResult> {
  core.guardShutdown()
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)
    const resolvedParams = await resolveVectorText(
      scopedParams(params, options),
      entry.embeddingAdapter,
      core.abortController.signal,
      entry.embeddingAdapterName,
    )
    const workerSearch = core.orchestrator.hasWorkerPool()
      ? core.orchestrator.searchViaWorker.bind(core.orchestrator)
      : undefined
    const result = await executePreflight(resolvedParams, {
      manager,
      language: entry.language,
      config: entry.config,
      workerSearch,
      indexName,
      broadcastStats: broadcastStatsFor(core, options),
      partitionIds: options?.partitionIds,
      cursorBinding: queryBindingOf(params),
    })
    if (core.analysisRebuild.isStale(indexName)) {
      result.analysisStale = true
    }
    return result
  } finally {
    release()
  }
}

export async function runEngineSuggest(
  core: EngineCore,
  indexName: string,
  params: SuggestParams,
  partitionIds?: number[],
): Promise<SuggestResult> {
  core.guardShutdown()
  const release = await core.indexState.acquire(indexName)
  try {
    const result = executeSuggest(
      core.requireManager(indexName),
      core.requireIndex(indexName).language,
      params,
      partitionIds,
    )
    if (core.analysisRebuild.isStale(indexName)) {
      result.analysisStale = true
    }
    return result
  } finally {
    release()
  }
}

export interface PartitionQueryStats {
  totalDocuments: number
  docFrequencies: Record<string, number>
  totalFieldLengths: Record<string, number>
}

/**
 * Collects the term statistics a peer node needs to score a query against the
 * partitions this engine holds. The engine holds the index open for the whole
 * read.
 *
 * @param core - The engine services that hold the index.
 * @param indexName - The index to read.
 * @param terms - The query terms whose document frequencies the caller needs.
 * @param partitionIds - The partitions to count, or every partition when omitted.
 * @returns The document total, the document frequency of each term, and the
 * total field lengths across the counted partitions.
 */
export async function runEngineQueryStats(
  core: EngineCore,
  indexName: string,
  terms: string[],
  partitionIds?: number[],
): Promise<PartitionQueryStats> {
  core.guardShutdown()
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)
    const stats = collectQueryTermStats(
      manager,
      terms.join(' '),
      entry.language,
      {
        stopWords: manager.analysis.stopWords,
        customTokenizer: manager.analysis.customTokenizer,
      },
      partitionIds,
    )
    return {
      totalDocuments: stats.totalDocuments,
      docFrequencies: stats.docFrequencies,
      totalFieldLengths: stats.totalFieldLengths,
    }
  } finally {
    release()
  }
}

export async function runEngineListDocuments<T = AnyDocument>(
  core: EngineCore,
  indexName: string,
  params: ListParams,
  partitionIds?: number[],
): Promise<ListResult<T>> {
  core.guardShutdown()
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    return executeListDocuments<T>(params, {
      manager: core.requireManager(indexName),
      schema: entry.config.schema,
      partitionIds,
    })
  } finally {
    release()
  }
}
