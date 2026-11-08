import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { expandPrefix as portablePrefix } from './portable'

export const expandPrefix: typeof portablePrefix = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.expandPrefix(...args)
    noteFallback('expandPrefix')
  }
  return portablePrefix(...args)
}
