import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeSegmentCore } from '../../vector/native/types/segments'
import * as portable from './portable'

export const indexTerms: NativeSegmentCore['indexTerms'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.indexTerms(...args)
    noteFallback('indexTerms')
  }
  return portable.indexTerms(...args)
}

export const removeDocument: NativeSegmentCore['removeDocument'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.removeDocument(...args)
    noteFallback('removeDocument')
  }
  return portable.removeDocument(...args)
}

export const beginBatch: NativeSegmentCore['beginBatch'] = segment => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.beginBatch(segment)
    noteFallback('beginBatch')
  }
  return portable.beginBatch(segment)
}

export const endBatch: NativeSegmentCore['endBatch'] = segment => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.endBatch(segment)
    noteFallback('endBatch')
  }
  return portable.endBatch(segment)
}
