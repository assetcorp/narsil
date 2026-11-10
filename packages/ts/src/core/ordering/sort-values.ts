import type { AnyDocument } from '../../types/schema'
import type { SortField } from '../../types/search'
import { SORT_VALUE_MAX_CODE_POINTS } from './constants'

export type SortDirection = 'asc' | 'desc'

export type SortMode = NonNullable<SortField['mode']>

export type ComparableSortValue = string | number | boolean | null

export const SORT_MODES: readonly SortMode[] = ['min', 'max', 'avg', 'median']

export function isSortMode(value: unknown): value is SortMode {
  return value === 'min' || value === 'max' || value === 'avg' || value === 'median'
}

export function defaultSortMode(direction: SortDirection): SortMode {
  return direction === 'desc' ? 'max' : 'min'
}

export function sortModeOf(entry: { direction: SortDirection; mode?: SortMode }): SortMode {
  return entry.mode ?? defaultSortMode(entry.direction)
}

/**
 * Cuts a string sort value to the specification's comparison window of 512
 * code points. A supplementary character at the boundary stays whole.
 *
 * @param value - The string to cut.
 * @returns The first 512 code points of `value`, or `value` itself when it already fits.
 */
export function truncateSortString(value: string): string {
  if (value.length <= SORT_VALUE_MAX_CODE_POINTS) return value
  let index = 0
  let counted = 0
  while (index < value.length && counted < SORT_VALUE_MAX_CODE_POINTS) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit < 0xdc00 && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low < 0xe000) index++
    }
    index++
    counted++
  }
  return value.slice(0, index)
}

/**
 * Reduces a raw document field to the value the sort value order compares: a
 * string cut to the comparison window, a finite number, or a boolean. A
 * missing field, a null, an array, an object, and a number that is not finite
 * each become null. The order treats null as missing.
 *
 * @param value - The raw field value.
 * @returns The comparable value, or null when the value counts as missing.
 */
export function toComparableSortValue(value: unknown): ComparableSortValue {
  if (typeof value === 'string') return truncateSortString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return null
}

/**
 * Reads the value a sort field names from a document, following the field path
 * one segment at a time. A segment the document does not own itself stops the
 * walk, so a path naming an inherited property reads as missing.
 *
 * @param document - The stored document.
 * @param path - The sort field's path, with dots between segments.
 * @returns The raw value, or undefined when the document does not carry it.
 */
export function readSortField(document: AnyDocument, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = document
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    if (!Object.hasOwn(current as Record<string, unknown>, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
