import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeTermCore, NativeTermDictionary } from '../../vector/native/types/terms'
import * as portable from './portable'

export function findOwnedTerm(dictionary: NativeTermDictionary, text: string): number | undefined | null {
  if (dictionary.growing === null) return null
  if (nativeSearchCoreIsEnabled()) {
    if (loadNativeCore() !== null) return null
    noteFallback('lookupExact')
  }
  return portable.findOwnedTerm(dictionary, text)
}

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
