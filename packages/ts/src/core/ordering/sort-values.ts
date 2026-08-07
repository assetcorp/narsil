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
