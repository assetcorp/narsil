import { optionalCodeHost } from '../engine/optional-code-host'
import { loadMessagePack } from '../serialization/msgpack-code'
import { codeLoader } from '../workers/code-loader'
import type * as SuggestionStoreLeaf from './store-leaf'

export type SuggestionStore = typeof SuggestionStoreLeaf

const suggestionStore = codeLoader<SuggestionStore>(async () => {
  const [msgpack, code] = await Promise.all([loadMessagePack(), import('./store-leaf')])
  code.bindSuggestionStoreHost(optionalCodeHost(), msgpack)
  return code
}, 'query suggestions store')

export const loadSuggestionStore = suggestionStore.load
