import { holdsStringArrayField } from '../engine/array-positions'
import type { EngineCore } from '../engine/core'
import { executeListDocuments } from '../engine/list-documents'
import { yieldToEventLoop } from '../engine/orchestration/turn'
import { executePreflight, executeQuery } from '../engine/query'
import { resolveVectorText } from '../engine/resolve-vector-text'
import { executeSuggest } from '../engine/suggest'
import { collectQueryTermStats } from '../partitioning/distributed-scoring'
import type { StatsExpansion } from '../partitioning/expanded-tokens'
import type { PartitionManager } from '../partitioning/manager/types'
import { lazyQueryBinding } from '../search/cursor-binding'
import { loadPhraseCodeFor, requireLoadedPhraseCode } from '../search/phrase-code'
import type { GlobalStatistics } from '../types/internal'
import type { ListResult, PreflightResult, QueryResult, SuggestResult } from '../types/results'
import type { AnyDocument, IndexConfig } from '../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../types/search'

export interface ScopedReadOptions {
  partitionIds?: number[]
  globalStats?: GlobalStatistics
  rescoreWindow?: number
  onRanked?: (manager: PartitionManager, result: QueryResult<unknown>) => void
}

async function enterRead(core: EngineCore, indexName: string): Promise<void> {
  core.guardShutdown()
  if (core.rebalancingIndexes.has(indexName)) await yieldToEventLoop()
}

async function readUnderOneAnalysis<R>(
  core: EngineCore,
  indexName: string,
  read: () => Promise<R>,
): Promise<{ result: R; analysisStale: boolean }> {
  let analysisStale = core.analysisRebuild.isStale(indexName)
  let result = await read()
  while (core.analysisRebuild.isStale(indexName) !== analysisStale) {
    analysisStale = core.analysisRebuild.isStale(indexName)
    result = await read()
  }
  return { result, analysisStale }
}

function phraseReadinessOf(core: EngineCore, indexName: string, config: IndexConfig): () => void {
  return () => {
    if (!core.analysisRebuild.isStale(indexName) || !holdsStringArrayField(config.schema)) return
    requireLoadedPhraseCode().refusePhraseUntilRebuilt(indexName, core.analysisRebuild.rebuildMode)
  }
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
  await enterRead(core, indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)

    const scoped = scopedParams(params, options)
    await core.pluginRegistry.runHook('beforeSearch', { indexName, params: scoped })

    const rerank = scoped.rerank === undefined ? undefined : await import('../rerank/runtime')
    const resolvedParams = await resolveVectorText(
      rerank === undefined ? scoped : rerank.withRerankQueryText(scoped),
      entry.embeddingAdapter,
      core.abortController.signal,
      entry.embeddingAdapterName,
    )

    const workerSearch = core.orchestrator.hasWorkerPool()
      ? core.orchestrator.searchViaWorker.bind(core.orchestrator)
      : undefined

    const context = {
      manager,
      language: entry.language,
      config: entry.config,
      workerSearch,
      indexName,
      broadcastStats: broadcastStatsFor(core, options),
      partitionIds: options?.partitionIds,
      rescoreWindow: options?.rescoreWindow,
      cursorBinding: lazyQueryBinding(params),
      patternWorkCap: core.patternWorkCap,
      rerank: rerank?.rerankRunnerFor(core),
      requirePhraseReady: phraseReadinessOf(core, indexName, entry.config),
    }
    const { result, analysisStale } = await readUnderOneAnalysis(core, indexName, () =>
      executeQuery<T>(resolvedParams, context),
    )
    if (analysisStale) {
      result.analysisStale = true
    }
    options?.onRanked?.(manager, result)

    if (core.pluginRegistry.hasHooks('afterSearch')) {
      const observed = { ...result, hits: [...result.hits] } as unknown as QueryResult
      try {
        await core.pluginRegistry.runHook('afterSearch', { indexName, params: resolvedParams, results: observed })
      } catch (err) {
        console.warn('afterSearch plugin hook error:', err)
      }
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
  await enterRead(core, indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)
    const scoped = scopedParams(params, options)
    await core.pluginRegistry.runHook('beforeSearch', { indexName, params: scoped })

    const resolvedParams = await resolveVectorText(
      scoped,
      entry.embeddingAdapter,
      core.abortController.signal,
      entry.embeddingAdapterName,
    )

    const workerSearch = core.orchestrator.hasWorkerPool()
      ? core.orchestrator.searchViaWorker.bind(core.orchestrator)
      : undefined
    const context = {
      manager,
      language: entry.language,
      config: entry.config,
      workerSearch,
      indexName,
      broadcastStats: broadcastStatsFor(core, options),
      partitionIds: options?.partitionIds,
      cursorBinding: lazyQueryBinding(params),
      patternWorkCap: core.patternWorkCap,
      requirePhraseReady: phraseReadinessOf(core, indexName, entry.config),
    }
    const { result, analysisStale } = await readUnderOneAnalysis(core, indexName, () =>
      executePreflight(resolvedParams, context),
    )
    if (analysisStale) {
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
  await enterRead(core, indexName)
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
  expanded?: string[]
}

export interface QueryStatsRequestScope {
  expansion?: StatsExpansion
  tokens?: readonly string[]
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
 * @param scope - The query's matching options, under which the engine also
 * counts every token that typo tolerance, prefix completion, or partial-word
 * search reaches in a counted partition, and the tokens that the caller wants
 * counted as given. Omit it to count the terms and their synonyms alone.
 * @returns The document total, the document frequency of each counted token,
 * the total field lengths across the counted partitions, and the tokens that a
 * prefix completion or a partial-word search reached.
 */
export async function runEngineQueryStats(
  core: EngineCore,
  indexName: string,
  terms: string[],
  partitionIds?: number[],
  scope?: QueryStatsRequestScope,
): Promise<PartitionQueryStats> {
  await enterRead(core, indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)
    const term = terms.join(' ')
    const loadingPhraseCode = loadPhraseCodeFor(term)
    if (loadingPhraseCode !== null) await loadingPhraseCode
    const analysis = {
      stopWords: manager.analysis.stopWords,
      customTokenizer: manager.analysis.customTokenizer,
      synonyms: manager.synonyms,
    }
    const stats = collectQueryTermStats(manager, term, entry.language, analysis, partitionIds, {
      expansion: scope?.expansion === undefined ? undefined : { options: scope.expansion, schema: entry.config.schema },
      tokens: scope?.tokens,
    })
    return {
      totalDocuments: stats.totalDocuments,
      docFrequencies: stats.docFrequencies,
      totalFieldLengths: stats.totalFieldLengths,
      ...(stats.expanded.length > 0 ? { expanded: stats.expanded } : {}),
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
  await enterRead(core, indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    return executeListDocuments<T>(params, {
      manager: core.requireManager(indexName),
      schema: entry.config.schema,
      strict: entry.config.strict,
      partitionIds,
      patternWorkCap: core.patternWorkCap,
    })
  } finally {
    release()
  }
}
