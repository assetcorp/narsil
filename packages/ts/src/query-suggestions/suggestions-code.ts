import { optionalCodeHost } from '../engine/optional-code-host'
import { codeLoader } from '../workers/code-loader'
import { loadSuggestionStore } from './store-code'
import type * as SuggestionsLeaf from './suggestions-leaf'

export type SuggestionsCode = typeof SuggestionsLeaf

const suggestionsCode = codeLoader<SuggestionsCode>(async () => {
  const [suggestionStore, code] = await Promise.all([loadSuggestionStore(), import('./suggestions-leaf')])
  code.bindSuggestionsHost(optionalCodeHost(), suggestionStore)
  return code
}, 'query suggestions')

export const loadSuggestionsCode = suggestionsCode.load
