import { joinPatternWorkMeter } from '../core/pattern-index/work-meter'
import { sanitizeGlobalStats } from '../partitioning/distributed-scoring'
import { type FanOutResult, fanOutQuery } from '../partitioning/fan-out'
import type { PartitionManager } from '../partitioning/manager'
import { countsWithoutScores, fanOutMatchCount } from '../partitioning/match-count'
import type { FulltextSearchOptions } from '../search/fulltext'
import { loadPhraseCodeFor } from '../search/phrase-code'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { WorkerAction } from './protocol'

export interface QueryActionEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
  searchOptions: FulltextSearchOptions
}

type QueryAction = Extract<WorkerAction, { type: 'query' | 'preflight' }>

export async function runQueryAction(entry: QueryActionEntry, action: QueryAction): Promise<unknown> {
  const loadingPhraseCode = loadPhraseCodeFor(action.params.term)
  if (loadingPhraseCode !== null) await loadingPhraseCode
  const patternWork = joinPatternWorkMeter(action.patternWork, action.params.filters)
  const searchOptions = { ...entry.searchOptions, patternWork }
  if (action.type === 'query') {
    const result: FanOutResult = await fanOutQuery(
      entry.manager,
      action.params,
      entry.language,
      entry.config.schema,
      {
        scoringMode: action.params.scoring ?? entry.config.defaultScoring ?? 'local',
        partitionIds: action.partitionIds,
        ...(action.globalStats !== undefined ? { globalStats: sanitizeGlobalStats(action.globalStats) } : {}),
      },
      searchOptions,
    )
    result.patternWorkSpent = patternWork.spent()
    return result
  }
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
