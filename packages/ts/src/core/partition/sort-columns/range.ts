import { bitsetSet, createBitSet } from '../../bitset'
import { type ComparableSortValue, compareComparableValues, truncateSortString } from '../../ordering'
import type { SortColumn } from './index'
import { rankOfValue } from './order'

export interface TextRangeBounds {
  lower: string | null
  lowerInclusive: boolean
  upper: string | null
  upperInclusive: boolean
}

function withinBounds(value: ComparableSortValue, bounds: TextRangeBounds): boolean {
  if (value === null) return false
  if (bounds.lower !== null) {
    const comparison = compareComparableValues(value, bounds.lower, 'asc')
    if (comparison < 0 || (comparison === 0 && !bounds.lowerInclusive)) return false
  }
  if (bounds.upper !== null) {
    const comparison = compareComparableValues(value, bounds.upper, 'asc')
    if (comparison > 0 || (comparison === 0 && !bounds.upperInclusive)) return false
  }
  return true
}

export function selectTextRange(
  column: SortColumn,
  requested: TextRangeBounds,
  capacity: number,
  isLive: (internalId: number) => boolean,
): Uint32Array {
  const bounds: TextRangeBounds = {
    ...requested,
    lower: requested.lower === null ? null : truncateSortString(requested.lower),
    upper: requested.upper === null ? null : truncateSortString(requested.upper),
  }
  const order = column.order
  const ordered = order.ordered
  const result = createBitSet(capacity)

  let start = 0
  if (bounds.lower !== null) {
    const lowerRank = rankOfValue(order, bounds.lower)
    start = column.seek(bounds.lowerInclusive ? lowerRank : lowerRank + 1, 'asc')
  }
  let end = ordered.length
  if (bounds.upper !== null) {
    const upperRank = rankOfValue(order, bounds.upper)
    end = column.seek(bounds.upperInclusive ? upperRank + 1 : upperRank, 'asc')
  }

  for (let position = start; position < end; position++) {
    const internalId = ordered[position]
    if (!column.isDirty(internalId) && isLive(internalId)) bitsetSet(result, internalId)
  }

  for (const internalId of column.dirtyStream().present) {
    if (withinBounds(column.valueOf(internalId), bounds)) bitsetSet(result, internalId)
  }

  return result
}
