import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { expandPartialWords as portablePartial } from './partial'

export const expandPartialWords: typeof portablePartial = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.expandPartialWords(...args)
    noteFallback('expandPartialWords')
  }
  return portablePartial(...args)
}
