import { optionalCodeHost } from '../engine/optional-code-host'
import { codeLoader } from '../workers/code-loader'
import type * as SuggestionStoreLeaf from './store-leaf'

export type SuggestionStore = typeof SuggestionStoreLeaf

const suggestionStore = codeLoader<SuggestionStore>(async () => {
  const code = await import('./store-leaf')
  code.bindSuggestionStoreHost(optionalCodeHost())
  return code
}, 'query suggestions store')

export const loadSuggestionStore = suggestionStore.load
