import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeFrozenSegmentCore } from '../../vector/native/types/frozen-segments'
import * as portable from './portable'

export const removeFrozenDocument: NativeFrozenSegmentCore['removeFrozenDocument'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.removeFrozenDocument(...args)
    noteFallback('removeFrozenDocument')
  }
  return portable.removeFrozenDocument(...args)
}

export const prepareFrozenRemoval: NativeFrozenSegmentCore['prepareFrozenRemoval'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.prepareFrozenRemoval(...args)
    noteFallback('removeFrozenDocument')
  }
  return portable.prepareFrozenRemoval(...args)
}
