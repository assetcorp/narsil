import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeTermCore } from '../../vector/native/types/terms'
import * as portable from './portable'

export const lookupExact: NativeTermCore['lookupExact'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.lookupExact(...args)
    noteFallback('lookupExact')
  }
  return portable.lookupExact(...args)
}

export const lookupExactBatch: NativeTermCore['lookupExactBatch'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.lookupExactBatch(...args)
    noteFallback('lookupExactBatch')
  }
  return portable.lookupExactBatch(...args)
}

export const lookupPrefix: NativeTermCore['lookupPrefix'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.lookupPrefix(...args)
    noteFallback('lookupPrefix')
  }
  return portable.lookupPrefix(...args)
}

export const lookupTypo: NativeTermCore['lookupTypo'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.lookupTypo(...args)
    noteFallback('lookupTypo')
  }
  return portable.lookupTypo(...args)
}

export const documentFrequency: NativeTermCore['documentFrequency'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.documentFrequency(...args)
    noteFallback('documentFrequency')
  }
  return portable.documentFrequency(...args)
}
