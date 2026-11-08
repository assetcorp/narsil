import { reduceSortValue } from '#platform/sort-value'
import { type ComparableSortValue, readSortField, type SortMode } from '../core/ordering'
import type { AnyDocument } from '../types/schema'

export function readSortValues(
  document: AnyDocument | undefined,
  fields: readonly string[],
  modes: readonly SortMode[],
): ComparableSortValue[] {
  if (!document) return fields.map(() => null)
  return fields.map((field, index) => reduceSortValue(readSortField(document, field), modes[index] ?? 'min'))
}
