import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { clockNow as portableClock, matchPhrases as portableMatch } from './portable'

export const matchPhrases: typeof portableMatch = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.matchPhrases(...args)
    noteFallback('matchPhrases')
  }
  return portableMatch(...args)
}

export function clockNow(into: BigUint64Array): number {
  const core = nativeSearchCoreIsEnabled() ? loadNativeCore() : null
  return core === null ? portableClock(into) : core.clockNow(into)
}
