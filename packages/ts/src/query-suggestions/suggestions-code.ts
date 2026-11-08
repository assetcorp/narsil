import { optionalCodeHost } from '../engine/optional-code-host'
import { loadMessagePack } from '../serialization/msgpack-code'
import { codeLoader } from '../workers/code-loader'
import { loadSuggestionStore } from './store-code'
import type * as SuggestionsLeaf from './suggestions-leaf'

export type SuggestionsCode = typeof SuggestionsLeaf

const suggestionsCode = codeLoader<SuggestionsCode>(async () => {
  const [msgpack, suggestionStore, code] = await Promise.all([
    loadMessagePack(),
    loadSuggestionStore(),
    import('./suggestions-leaf'),
  ])
  code.bindSuggestionsHost(optionalCodeHost(), msgpack, suggestionStore)
  return code
}, 'query suggestions')

export const loadSuggestionsCode = suggestionsCode.load
