import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { expandSynonyms as portableExpandSynonyms } from './portable'

export const expandSynonyms: typeof portableExpandSynonyms = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.expandSynonyms(...args)
    noteFallback('expandSynonyms')
  }
  return portableExpandSynonyms(...args)
}
