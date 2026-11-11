import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { suggestTerms as portable } from './suggestions'

export const suggestTerms: typeof portable = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.suggestTerms(...args)
    noteFallback('suggestTerms')
  }
  return portable(...args)
}
