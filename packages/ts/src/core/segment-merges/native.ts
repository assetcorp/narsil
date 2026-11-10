import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type {
  NativeKeywordMergeInput,
  NativeKeywordMergeOutput,
  NativeSegmentMergeCore,
} from '../../vector/native/types/segment-merge'
import type { MergeOutputAllocator } from './portable'
import * as portable from './portable'

const MERGE_SIZE_COUNT = 9

import { mergePostings as portablePostings } from './postings'

export const mergePostings: NativeSegmentMergeCore['mergePostings'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.mergePostings(...args)
    noteFallback('mergePostings')
  }
  return portablePostings(...args)
}

export function mergeKeywords(
  inputs: readonly NativeKeywordMergeInput[],
  documentCount: number,
  fieldCount: number,
  allocate: MergeOutputAllocator,
  retained: NativeFrozenStrings | null,
): NativeKeywordMergeOutput | number {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) {
      const sizes = new Uint32Array(MERGE_SIZE_COUNT)
      const measured = core.measureMerge(inputs, documentCount, fieldCount, sizes, retained)
      if (measured !== 0) return measured
      const output = allocate(sizes, documentCount, fieldCount)
      const written = core.writeMerge(inputs, documentCount, fieldCount, output, retained)
      return written === 0 ? output : written
    }
    noteFallback('measureMerge')
  }
  return portable.mergeKeywords(inputs, documentCount, fieldCount, allocate, retained)
}
