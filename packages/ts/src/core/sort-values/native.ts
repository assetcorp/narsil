import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import type { ComparableSortValue, SortMode } from '../ordering/sort-values'
import { reduceStoredWith, reduceWith } from './adapter'
import { buildSortOrder as portableBuildSortOrder } from './order'
import { sortValue } from './portable'
import { textRange as portableTextRange } from './range'
import { sortSelect as portableSortSelect } from './select'

export const sortSelect: typeof portableSortSelect = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.sortSelect(...args)
    noteFallback('sortSelect')
  }
  return portableSortSelect(...args)
}

export const textRange: typeof portableTextRange = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.textRange(...args)
    noteFallback('textRange')
  }
  return portableTextRange(...args)
}

export const buildSortOrder: typeof portableBuildSortOrder = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.buildSortOrder(...args)
    noteFallback('buildSortOrder')
  }
  return portableBuildSortOrder(...args)
}

export function reduceSortValue(value: unknown, mode: SortMode): ComparableSortValue {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return reduceWith(core.sortValue, value, mode)
    noteFallback('sortValue')
  }
  return reduceWith(sortValue, value, mode)
}

export function reduceStoredSortValue(
  values: NativeStoredValues,
  ordinal: number,
  mode: SortMode,
): ComparableSortValue {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return reduceStoredWith(core.sortValue, values, ordinal, mode)
    noteFallback('sortValue')
  }
  return reduceStoredWith(sortValue, values, ordinal, mode)
}
