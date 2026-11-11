import type { EngineCore } from '../engine/core'
import { ErrorCodes, NarsilError } from '../errors'
import { engineCoreOf } from '../narsil/internals'
import type { Narsil } from '../types/engine'
import type { QuerySuggestions } from '../types/query-suggestions'
import { GROUP_FORMAT, GROUP_PATTERN_SOURCE, SUGGESTIONS_INDEX_INFIX } from './index-names/constants'
import { boundQuerySuggestionsOf } from './providers'
import { loadSuggestionsCode } from './suggestions-code'

export type {
  ManualQuerySuggestion,
  QuerySuggestionPreviewEntry,
  QuerySuggestions,
  QuerySuggestionsBuild,
  QuerySuggestionsBuildEvent,
  QuerySuggestionsBuildTrigger,
  QuerySuggestionsPreview,
  QuerySuggestionsSetting,
  QuerySuggestionsSource,
  QuerySuggestionsStatus,
  QuerySuggestionsWarningEvent,
  QuerySuggestionsWarningReason,
  RecordedQuery,
  RecordQueryOutcome,
  RecordQueryResult,
} from '../types/query-suggestions'

/**
 * Returns popular query suggestions for an engine that {@link createNarsil}
 * made. Give the engine a key through its `querySuggestions` setting before
 * you turn the feature on for an index.
 *
 * @param engine - The engine whose indexes the suggestions come from.
 * @returns The operations that count searches and build suggestions.
 *
 * @public
 */
export function querySuggestions(engine: Narsil): QuerySuggestions {
  const bound = boundQuerySuggestionsOf(engine)
  if (bound !== undefined) return bound()
  const core = engineCoreOf(engine)
  if (core === undefined) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Popular query suggestions need an engine that createNarsil made in this process',
    )
  }
  return lazyQuerySuggestionsOf(core, engine)
}

function checkedSuggestionsIndexName(indexName: string, group: string): string {
  if (typeof group !== 'string' || !new RegExp(GROUP_PATTERN_SOURCE).test(group)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `A group holds ${GROUP_FORMAT}`, {})
  }
  return `${indexName}${SUGGESTIONS_INDEX_INFIX}${group}`
}

function lazyQuerySuggestionsOf(core: EngineCore, engine: Narsil): QuerySuggestions {
  const local = async () => (await loadSuggestionsCode()).localQuerySuggestionsOf(core, engine)
  return {
    recordQuery: async (indexName, query) => (await local()).recordQuery(indexName, query),
    updateSetting: async (indexName, setting) => (await local()).updateSetting(indexName, setting),
    status: async indexName => (await local()).status(indexName),
    build: async indexName => (await local()).build(indexName),
    preview: async (indexName, limit) => (await local()).preview(indexName, limit),
    bans: async indexName => (await local()).bans(indexName),
    updateBans: async (indexName, phrases) => (await local()).updateBans(indexName, phrases),
    removeQuery: async (indexName, query) => (await local()).removeQuery(indexName, query),
    addSuggestion: async (indexName, suggestion) => (await local()).addSuggestion(indexName, suggestion),
    suggestionsIndexName: checkedSuggestionsIndexName,
  }
}
