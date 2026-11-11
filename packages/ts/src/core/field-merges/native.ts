import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeFieldMergeCore } from '../../vector/native/types/field-merge'
import * as portable from './portable'

export const measureFieldMerge: NativeFieldMergeCore['measureFieldMerge'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.measureFieldMerge(...args)
    noteFallback('measureFieldMerge')
  }
  return portable.measureFieldMerge(...args)
}

export const writeFieldMerge: NativeFieldMergeCore['writeFieldMerge'] = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.writeFieldMerge(...args)
    noteFallback('writeFieldMerge')
  }
  return portable.writeFieldMerge(...args)
}
