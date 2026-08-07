import type { AnyDocument } from '../../types/schema'
import { compareSortStrings } from './fold-compare'

export type SortDirection = 'asc' | 'desc'

export type ComparableSortValue = string | number | boolean | null

export const SORT_VALUE_MAX_CODE_POINTS = 512

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

function typeRank(value: string | number | boolean): number {
  if (typeof value === 'number') return 0
  if (typeof value === 'string') return 1
  return 2
}

function comparePresentValues(a: string | number | boolean, b: string | number | boolean): number {
  const rankDifference = typeRank(a) - typeRank(b)
  if (rankDifference !== 0) return rankDifference
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return compareSortStrings(a, b)
  if (a === b) return 0
  return a ? 1 : -1
}

/**
 * Compares two values that have already been reduced to comparable form, under
 * the specification's rules for one sort field. A missing value orders last,
 * and the direction does not reach it.
 *
 * @param a - The first document's value for the field.
 * @param b - The second document's value for the field.
 * @param direction - The field's sort direction.
 * @returns A negative number when the first value orders first, a positive number when the second does, and 0 when they are equal.
 */
export function compareComparableValues(
  a: ComparableSortValue,
  b: ComparableSortValue,
  direction: SortDirection,
): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const comparison = comparePresentValues(a, b)
  if (comparison === 0) return 0
  return direction === 'desc' ? -comparison : comparison
}

/**
 * Compares two sort keys whose values have already been reduced to comparable
 * form, field by field in sort order.
 *
 * @param aKey - The first document's values, one per sort field in sort order.
 * @param bKey - The second document's values, in the same order.
 * @param directions - The direction of each sort field.
 * @returns A negative number when the first document orders first, a positive number when the second does, and 0 when every field leaves them equal.
 */
export function compareComparableKeys(
  aKey: readonly ComparableSortValue[],
  bKey: readonly ComparableSortValue[],
  directions: readonly SortDirection[],
): number {
  for (let i = 0; i < directions.length; i++) {
    const comparison = compareComparableValues(aKey[i] ?? null, bKey[i] ?? null, directions[i])
    if (comparison !== 0) return comparison
  }
  return 0
}

/**
 * Compares two documents' sort values field by field, as the specification's
 * sort value order defines. The first field that separates the documents
 * decides. A missing value orders last under either direction. Present values
 * of different types rank numbers before strings before booleans. A `desc`
 * direction reverses everything except the missing rule.
 *
 * @param aValues - The first document's raw values, one per sort field in sort order.
 * @param bValues - The second document's raw values, in the same order.
 * @param directions - The direction of each sort field.
 * @returns A negative number when the first document orders first, a positive number when the second does, and 0 when every field leaves them equal.
 */
export function compareSortValues(
  aValues: readonly unknown[],
  bValues: readonly unknown[],
  directions: readonly SortDirection[],
): number {
  for (let i = 0; i < directions.length; i++) {
    const a = toComparableSortValue(aValues[i])
    const b = toComparableSortValue(bValues[i])

    if (a === null && b === null) continue
    if (a === null) return 1
    if (b === null) return -1

    const comparison = comparePresentValues(a, b)
    if (comparison !== 0) return directions[i] === 'desc' ? -comparison : comparison
  }
  return 0
}
