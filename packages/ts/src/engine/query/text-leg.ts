import { type FanOutResult, fanOutQuery } from '../../partitioning/fan-out'
import { returnsEveryMatch } from '../../search/fulltext'
import type { QueryParams } from '../../types/search'
import {
  bm25SettingFor,
  broadcastStatsForWorker,
  type SearchContext,
  scoringConfigFor,
  searchOptionsFor,
} from './shared'
import { requirePinnedState } from './state'

export async function textLeg(textOnlyParams: QueryParams, context: SearchContext): Promise<FanOutResult> {
  const { manager, language, config, workerSearch, indexName } = context
  const scoring = scoringConfigFor(textOnlyParams, context)
  if (workerSearch && !returnsEveryMatch(textOnlyParams)) {
    const viaWorker = await workerSearch(
      indexName,
      textOnlyParams,
      broadcastStatsForWorker(textOnlyParams, context, scoring),
      context.partitionIds,
      context.patternWork,
      bm25SettingFor(textOnlyParams, context),
      { kind: 'documents' },
    )
    if (viaWorker) return viaWorker
  }
  requirePinnedState(context.pin)
  return fanOutQuery(
    manager,
    textOnlyParams,
    language,
    config.schema,
    scoring,
    searchOptionsFor(textOnlyParams, context),
  )
}
