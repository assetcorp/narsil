import { loadPrefixFor } from '../core/partition/suggestion-code'
import { holdsStringArrayField } from '../engine/array-positions'
import type { EngineCore } from '../engine/core'
import { holdIndex } from '../engine/index-hold'
import { importOptionalReads } from '../engine/optional-reads-code'
import { yieldToEventLoop } from '../engine/orchestration/turn'
import { executePreflight, executeQuery, loadQueryCode } from '../engine/query'
import { loadRerankRuntime } from '../engine/query/fixed-depth-code'
import { answerFromOneState } from '../engine/query/state'
import type { EmbeddedQuery } from '../engine/resolve-vector-text'
import { loadResolveVectorText } from '../engine/resolve-vector-text-code'
import { ErrorCodes, NarsilError } from '../errors'
import { collectQueryTermStats } from '../partitioning/distributed-scoring'
import type { StatsExpansion } from '../partitioning/expanded-tokens'
import type { PartitionManager } from '../partitioning/manager/types'
import type { HeldIndexRerankRunner } from '../rerank/runner'
import { lazyQueryBinding } from '../search/cursor-binding'
import { loadMessagePackForStoredValues } from '../search/object-values'
import { loadPhraseCodeFor, requireLoadedPhraseCode } from '../search/phrase-code'
import { loadSortingFor } from '../search/sorting-code'
import type { GlobalStatistics } from '../types/internal'
import type { ListResult, PreflightResult, QueryResult, SuggestResult } from '../types/results'
import type { AnyDocument, BM25Params, IndexConfig } from '../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../types/search'

export interface ScopedReadOptions {
  signal?: AbortSignal
  partitionIds?: number[]
  globalStats?: GlobalStatistics
  rescoreWindow?: number
  indexBm25?: BM25Params
  onRanked?: (manager: PartitionManager, result: QueryResult<unknown>) => void
}

async function enterRead(core: EngineCore, indexName: string): Promise<void> {
  core.guardShutdown()
  if (core.rebalancingIndexes.has(indexName)) await yieldToEventLoop()
}

type RerankRuntime = Awaited<ReturnType<typeof loadRerankRuntime>>

async function embeddedFor(
  core: EngineCore,
  indexName: string,
  params: QueryParams,
  signal: AbortSignal,
  earlier: EmbeddedQuery | null,
): Promise<EmbeddedQuery | null> {
  if (params.vector?.text === undefined) return null
  const { embedQueryWithAdapterOf } = await loadResolveVectorText()
  return embedQueryWithAdapterOf(indexName, params, core.requireIndex(indexName), signal, earlier)
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
  return (name: string, tokens: ReadonlySet<string>) => invalidation.broadcastStats(name, tokens)
}

const EMBEDDING_ADAPTER_CHANGED = 0
const INDEX_REPLACED_DURING_RERANK = 1

type QueryRerun = typeof EMBEDDING_ADAPTER_CHANGED | typeof INDEX_REPLACED_DURING_RERANK

async function queryUnderHold<T>(
  core: EngineCore,
  indexName: string,
  params: QueryParams,
  resolvedParams: QueryParams,
  embedded: EmbeddedQuery | null,
  rerank: RerankRuntime | undefined,
  options: ScopedReadOptions | undefined,
): Promise<QueryResult<T> | QueryRerun> {
  const hold = await holdIndex(core.indexState, indexName)
  let runner: HeldIndexRerankRunner | undefined
  try {
    const entry = core.requireIndex(indexName)
    if (embedded !== null && entry.embeddingAdapter !== embedded.adapter) return EMBEDDING_ADAPTER_CHANGED
    const manager = core.requireManager(indexName)
    const workerSearch = core.orchestrator.hasWorkerPool()
      ? core.orchestrator.searchViaWorker.bind(core.orchestrator)
      : undefined
    runner = rerank?.rerankRunnerFor(core, options?.signal, hold, indexName, manager)

    let analysisStale = false
    const result = await answerFromOneState(
      manager,
      attempt => {
        analysisStale = core.analysisRebuild.isStale(indexName)
        return executeQuery<T>(resolvedParams, {
          manager,
          pin: attempt.pin,
          turns: attempt,
          releaseRetrieval: attempt.releaseRetrieval,
          language: manager.language,
          config: manager.config,
          workerSearch,
          indexName,
          broadcastStats: broadcastStatsFor(core, options),
          partitionIds: options?.partitionIds,
          rescoreWindow: options?.rescoreWindow,
          indexBm25: options?.indexBm25,
          cursorBinding: lazyQueryBinding(params),
          patternWorkCap: core.patternWorkCap,
          rerank: runner,
          requirePhraseReady: phraseReadinessOf(core, indexName, entry.config),
        })
      },
      options?.signal,
    )
    if (runner?.replaced) return INDEX_REPLACED_DURING_RERANK
    if (analysisStale) {
      result.analysisStale = true
    }
    options?.onRanked?.(manager, result)
    return result
  } catch (error) {
    if (error instanceof NarsilError && error.code === ErrorCodes.RERANK_FAILED) throw error
    if (runner?.replaced) return INDEX_REPLACED_DURING_RERANK
    throw error
  } finally {
    hold.release()
  }
}

export async function runEngineQuery<T = AnyDocument>(
  core: EngineCore,
  indexName: string,
  params: QueryParams,
  options?: ScopedReadOptions,
): Promise<QueryResult<T>> {
  const signal =
    options?.signal === undefined
      ? core.abortController.signal
      : AbortSignal.any([core.abortController.signal, options.signal])
  options?.signal?.throwIfAborted()
  await enterRead(core, indexName)
  core.requireIndex(indexName)

  const scoped = scopedParams(params, options)
  if (core.pluginRegistry.hasHooks('beforeSearch')) {
    await core.pluginRegistry.runHook('beforeSearch', { indexName, params: scoped })
  }

  const rerank = scoped.rerank === undefined ? undefined : await loadRerankRuntime()
  const preparedParams = rerank === undefined ? scoped : rerank.withRerankQueryText(scoped)
  let embedded: EmbeddedQuery | null = null
  let replacedReranks = 0
  while (true) {
    embedded = await embeddedFor(core, indexName, preparedParams, signal, embedded)
    const resolvedParams = embedded?.params ?? preparedParams
    const loading = loadQueryCode(resolvedParams)
    if (loading !== null) await loading
    const result = await queryUnderHold<T>(core, indexName, params, resolvedParams, embedded, rerank, options)
    if (result === EMBEDDING_ADAPTER_CHANGED) continue
    if (result === INDEX_REPLACED_DURING_RERANK) {
      rerank?.refuseAfterIndexChanges(indexName, ++replacedReranks)
      continue
    }

    if (core.pluginRegistry.hasHooks('afterSearch')) {
      const observed = { ...result, hits: [...result.hits] } as unknown as QueryResult
      try {
        await core.pluginRegistry.runHook('afterSearch', { indexName, params: resolvedParams, results: observed })
      } catch (err) {
        console.warn('afterSearch plugin hook error:', err)
      }
    }
    return result
  }
}

async function preflightUnderHold(
  core: EngineCore,
  indexName: string,
  params: QueryParams,
  resolvedParams: QueryParams,
  embedded: EmbeddedQuery | null,
  options: ScopedReadOptions | undefined,
): Promise<PreflightResult | null> {
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    if (embedded !== null && entry.embeddingAdapter !== embedded.adapter) return null
    const manager = core.requireManager(indexName)
    const workerSearch = core.orchestrator.hasWorkerPool()
      ? core.orchestrator.searchViaWorker.bind(core.orchestrator)
      : undefined
    let analysisStale = false
    const result = await answerFromOneState(
      manager,
      attempt => {
        analysisStale = core.analysisRebuild.isStale(indexName)
        return executePreflight(resolvedParams, {
          manager,
          pin: attempt.pin,
          turns: attempt,
          releaseRetrieval: attempt.releaseRetrieval,
          language: manager.language,
          config: manager.config,
          workerSearch,
          indexName,
          broadcastStats: broadcastStatsFor(core, options),
          partitionIds: options?.partitionIds,
          indexBm25: options?.indexBm25,
          cursorBinding: lazyQueryBinding(params),
          patternWorkCap: core.patternWorkCap,
          requirePhraseReady: phraseReadinessOf(core, indexName, entry.config),
        })
      },
      options?.signal,
    )
    if (analysisStale) {
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
  const signal =
    options?.signal === undefined
      ? core.abortController.signal
      : AbortSignal.any([core.abortController.signal, options.signal])
  options?.signal?.throwIfAborted()
  await enterRead(core, indexName)
  core.requireIndex(indexName)
  const scoped = scopedParams(params, options)
  if (core.pluginRegistry.hasHooks('beforeSearch')) {
    await core.pluginRegistry.runHook('beforeSearch', { indexName, params: scoped })
  }

  let embedded: EmbeddedQuery | null = null
  while (true) {
    embedded = await embeddedFor(core, indexName, scoped, signal, embedded)
    const resolvedParams = embedded?.params ?? scoped
    const loading = loadQueryCode(resolvedParams)
    if (loading !== null) await loading
    const result = await preflightUnderHold(core, indexName, params, resolvedParams, embedded, options)
    if (result !== null) return result
  }
}

export async function runEngineSuggest(
  core: EngineCore,
  indexName: string,
  params: SuggestParams,
  partitionIds?: number[],
): Promise<SuggestResult> {
  const { executeSuggest } = await importOptionalReads()
  await enterRead(core, indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    const manager = core.requireManager(indexName)
    const result = await manager.publication.read(() => executeSuggest(manager, manager.language, params, partitionIds))
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
    const loadingPrefix = loadPrefixFor(scope?.expansion?.prefix)
    if (loadingPrefix !== null) await loadingPrefix
    return await manager.publication.read(() => {
      const analysis = {
        stopWords: manager.analysis.stopWords,
        customTokenizer: manager.analysis.customTokenizer,
        synonyms: manager.synonyms,
      }
      const stats = collectQueryTermStats(manager, term, entry.language, analysis, partitionIds, {
        expansion:
          scope?.expansion === undefined ? undefined : { options: scope.expansion, schema: entry.config.schema },
        tokens: scope?.tokens,
      })
      return {
        totalDocuments: stats.totalDocuments,
        docFrequencies: stats.docFrequencies,
        totalFieldLengths: stats.totalFieldLengths,
        ...(stats.expanded.length > 0 ? { expanded: stats.expanded } : {}),
      }
    })
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
  const { executeListDocuments } = await importOptionalReads()
  const loading = loadSortingFor(params.sort, params.filters)
  if (loading !== null) await loading
  await enterRead(core, indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)
    const storedValueCode = loadMessagePackForStoredValues(params, entry.config)
    if (storedValueCode !== null) await storedValueCode
    return await manager.publication.read(() =>
      executeListDocuments<T>(params, {
        manager,
        schema: entry.config.schema,
        strict: entry.config.strict,
        partitionIds,
        patternWorkCap: core.patternWorkCap,
      }),
    )
  } finally {
    release()
  }
}
