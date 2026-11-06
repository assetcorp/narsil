import { ErrorCodes, NarsilError } from '../errors'
import { engineCoreOf } from '../narsil/internals'
import type { Narsil } from '../types/engine'
import type { QuerySuggestions } from '../types/query-suggestions'
import { querySuggestionsOf } from './operations'
import { boundQuerySuggestionsOf } from './providers'
import { localRuntimeOf } from './start'

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
  return querySuggestionsOf(() => localRuntimeOf(core, engine, undefined))
}
