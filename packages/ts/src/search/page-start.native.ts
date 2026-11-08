import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../vector/native/backend'
import { pageStart as portablePageStart } from './page-start'

export const pageStart: typeof portablePageStart = (...args) => {
  if (!nativeSearchCoreIsEnabled()) return portablePageStart(...args)
  const core = loadNativeCore()
  if (core !== null) return core.pageStart(...args)
  noteFallback('pageStart')
  return portablePageStart(...args)
}
