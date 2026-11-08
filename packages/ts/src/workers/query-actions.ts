import { loadPrefixFor } from '../core/partition/suggestion-code'
import { joinPatternWorkMeter } from '../core/pattern-index/work-meter'
import { fillHits, rankPage } from '../engine/query/assemble'
import { documentsOf } from '../engine/query/copy-reads'
import { answerFromOneState, requirePinnedState } from '../engine/query/state'
import { ErrorCodes, NarsilError } from '../errors'
import { sanitizeGlobalStats } from '../partitioning/distributed-scoring'
import { type FanOutResult, fanOutQuery } from '../partitioning/fan-out'
import type { PartitionManager } from '../partitioning/manager'
import type { StatePin } from '../partitioning/manager/state-pins'
import { countsWithoutScores, fanOutMatchCount } from '../partitioning/match-count'
import { loadCursorPageFor } from '../search/cursor-page-code'
import { loadFacetMergesFor } from '../search/facets'
import type { FulltextSearchOptions } from '../search/fulltext'
import { loadGroupingFor } from '../search/grouping-code'
import { loadPhraseCodeFor } from '../search/phrase-code'
import { loadPinningFor } from '../search/pinning-code'
import { loadSortingFor } from '../search/sorting-code'
import type { LanguageModule } from '../types/language'
import type { AnyDocument, IndexConfig } from '../types/schema'
import type { WorkerAction } from './protocol'

export interface QueryActionEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
  searchOptions: FulltextSearchOptions
  copyPublications: { generation: number; failed: boolean }
}

type QueryAction = Extract<WorkerAction, { type: 'query' | 'preflight' }>

function withCopyReads(
  result: FanOutResult,
  action: Extract<WorkerAction, { type: 'query' }>,
  manager: PartitionManager,
  pin: StatePin,
): FanOutResult | Promise<FanOutResult> {
  const reads = action.reads
  if (reads === undefined) return result
  if (reads.kind === 'documents') {
    result.documents = documentsOf(
      pin,
      result.scored.map(scored => scored.docId),
    )
    return result
  }
  const ranked = rankPage<AnyDocument>(result, action.params, reads.page, manager.schema, () => reads.binding, pin)
  const filling = fillHits(ranked.paginated, ranked.groups, action.params, reads.page.projection, pin, {
    language: manager.language,
    analysis: manager.analysis,
    schema: manager.schema,
    synonyms: manager.synonyms,
  })
  const answer: FanOutResult = {
    scored: [],
    totalMatched: result.totalMatched,
    patternWorkSpent: result.patternWorkSpent,
    page: ranked,
  }
  return filling === undefined ? answer : filling.then(() => answer)
}

export async function runQueryAction(
  entry: QueryActionEntry,
  action: QueryAction,
  isCurrent: () => boolean,
): Promise<unknown> {
  const requireCurrent = (): void => {
    if (!isCurrent())
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${action.indexName}" is no longer held by this worker`)
    if (
      entry.copyPublications.failed ||
      (action.type === 'query' &&
        action.readGeneration !== undefined &&
        action.readGeneration !== entry.copyPublications.generation)
    ) {
      throw new NarsilError(ErrorCodes.WORKER_BUSY, 'The worker copy holds a different search publication')
    }
  }
  const loadingPhraseCode = loadPhraseCodeFor(action.params.term)
  const loadingCursorCode = loadCursorPageFor(action.params.searchAfter)
  const loadingGroupingCode = loadGroupingFor(action.params.group)
  const loadingPinningCode = loadPinningFor(action.params.pinned)
  const loadingFacetCode = loadFacetMergesFor(action.params.facets)
  const loadingSortingCode = loadSortingFor(action.params.sort, action.params.filters)
  const loadingPrefixCode = loadPrefixFor(action.params.prefix)
  if (
    loadingPhraseCode !== null ||
    loadingCursorCode !== null ||
    loadingGroupingCode !== null ||
    loadingPinningCode !== null ||
    loadingFacetCode !== null ||
    loadingSortingCode !== null ||
    loadingPrefixCode !== null
  ) {
    await Promise.all([
      loadingPhraseCode,
      loadingCursorCode,
      loadingGroupingCode,
      loadingPinningCode,
      loadingFacetCode,
      loadingSortingCode,
      loadingPrefixCode,
    ])
  }
  if (action.type === 'query') {
    const { manager } = entry
    return answerFromOneState(manager, async attempt => {
      requireCurrent()
      const bm25Params = action.bm25 ?? undefined
      const patternWork = joinPatternWorkMeter(action.patternWork, action.params.filters)
      requirePinnedState(attempt.pin)
      const result: FanOutResult = await fanOutQuery(
        manager,
        action.params,
        entry.language,
        entry.config.schema,
        {
          scoringMode: action.params.scoring ?? entry.config.defaultScoring ?? 'local',
          partitionIds: action.partitionIds,
          ...(action.globalStats !== undefined ? { globalStats: sanitizeGlobalStats(action.globalStats) } : {}),
        },
        { ...entry.searchOptions, patternWork, bm25Params, turns: attempt },
      )
      result.patternWorkSpent = patternWork.spent()
      return withCopyReads(result, action, manager, attempt.pin)
    })
  }
  return entry.manager.publication.read(() => {
    requireCurrent()
    return preflightOnCopy(entry, action, entry.config.bm25)
  })
}

async function preflightOnCopy(
  entry: QueryActionEntry,
  action: Extract<WorkerAction, { type: 'preflight' }>,
  bm25Params: FulltextSearchOptions['bm25Params'],
): Promise<{ count: number }> {
  const patternWork = joinPatternWorkMeter(action.patternWork, action.params.filters)
  const searchOptions = { ...entry.searchOptions, patternWork, bm25Params }
  if (countsWithoutScores(action.params)) {
    const count = fanOutMatchCount(entry.manager, action.params, entry.language, entry.config.schema, {
      searchOptions,
    })
    return { count }
  }
  const result = await fanOutQuery(
    entry.manager,
    action.params,
    entry.language,
    entry.config.schema,
    { scoringMode: entry.config.defaultScoring ?? 'local' },
    searchOptions,
  )
  return { count: result.totalMatched }
}
