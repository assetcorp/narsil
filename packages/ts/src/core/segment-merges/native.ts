import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeSegmentMergeCore } from '../../vector/native/types/segment-merge'
import * as portable from './portable'
import { mergePostings as portablePostings } from './postings'

export const mergePostings: NativeSegmentMergeCore['mergePostings'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.mergePostings(...args)
    noteFallback('mergePostings')
  }
  return portablePostings(...args)
}

export const measureMerge: NativeSegmentMergeCore['measureMerge'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.measureMerge(...args)
    noteFallback('measureMerge')
  }
  return portable.measureMerge(...args)
}

export const writeMerge: NativeSegmentMergeCore['writeMerge'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.writeMerge(...args)
    noteFallback('writeMerge')
  }
  return portable.writeMerge(...args)
}
