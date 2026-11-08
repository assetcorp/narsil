import type { EngineCore } from '../engine/core'
import type { Narsil } from '../types/engine'
import type { QuerySuggestions } from '../types/query-suggestions'
import { querySuggestionsOf } from './operations'
import { localRuntimeOf } from './start'

export { bindSuggestionsHost } from '#platform/suggestions-host'
export { localRuntimeOf } from './start'

export function localQuerySuggestionsOf(core: EngineCore, engine: Narsil): QuerySuggestions {
  return querySuggestionsOf(() => localRuntimeOf(core, engine, undefined))
}
