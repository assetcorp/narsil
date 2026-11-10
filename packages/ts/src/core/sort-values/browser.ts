import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import type { ComparableSortValue, SortMode } from '../ordering/sort-values'
import { reduceStoredWith, reduceWith } from './adapter'
import { sortValue } from './portable'

export { buildSortOrder } from './order'
export { textRange } from './range'
export { sortSelect } from './select'

export function reduceSortValue(value: unknown, mode: SortMode): ComparableSortValue {
  return reduceWith(sortValue, value, mode)
}

export function reduceStoredSortValue(
  values: NativeStoredValues,
  ordinal: number,
  mode: SortMode,
): ComparableSortValue {
  return reduceStoredWith(sortValue, values, ordinal, mode)
}
