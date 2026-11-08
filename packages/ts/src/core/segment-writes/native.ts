import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeGrowingSegment, NativeSegmentCore } from '../../vector/native/types/segments'
import * as portable from './portable'
import { type PreparedSegmentField, packedFields } from './prepared-tokens'

export const indexTerms: NativeSegmentCore['indexTerms'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.indexTerms(...args)
    noteFallback('indexTerms')
  }
  return portable.indexTerms(...args)
}

export function indexPreparedTerms(
  segment: NativeGrowingSegment,
  ordinal: number,
  fields: readonly PreparedSegmentField[],
): number {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.indexTerms(segment, ordinal, packedFields(fields))
    noteFallback('indexTerms')
  }
  return portable.indexPreparedTerms(segment, ordinal, fields)
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
