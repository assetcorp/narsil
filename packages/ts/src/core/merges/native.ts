import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { mergeRankings as portableRankings, mergeSorted as portableSorted } from './portable'

export const mergeRankings: typeof portableRankings = (...args) => {
  if (!nativeSearchCoreIsEnabled()) return portableRankings(...args)
  const core = loadNativeCore()
  if (core !== null) return core.mergeRankings(...args)
  noteFallback('mergeRankings')
  return portableRankings(...args)
}

export const mergeSorted: typeof portableSorted = (...args) => {
  if (!nativeSearchCoreIsEnabled()) return portableSorted(...args)
  const core = loadNativeCore()
  if (core !== null) return core.mergeSorted(...args)
  noteFallback('mergeSorted')
  return portableSorted(...args)
}
