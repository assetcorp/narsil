import { type ComparableSortValue, compareComparableValues } from '../../ordering'
import type { ValueStore } from './values'

export const MISSING_RANK = -1

const BYTES_PER_RANK = 4
const BYTES_PER_ORDERED_ENTRY = 4

export interface SortColumnOrder {
  values: ComparableSortValue[]
  ranks: Int32Array
  ordered: Int32Array
  missing: Int32Array
}

function compareAscending(a: ComparableSortValue, b: ComparableSortValue): number {
  return compareComparableValues(a, b, 'asc')
}

export function buildOrder(store: ValueStore, liveIds: Iterable<number>, capacity: number): SortColumnOrder {
  const counts = new Map<ComparableSortValue, number>()
  const present: number[] = []
  const missing: number[] = []

  for (const internalId of liveIds) {
    const value = store.get(internalId)
    if (value === null) {
      missing.push(internalId)
      continue
    }
    present.push(internalId)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  const values = Array.from(counts.keys())
  values.sort(compareAscending)

  const indexOfValue = new Map<ComparableSortValue, number>()
  for (let i = 0; i < values.length; i++) indexOfValue.set(values[i], i)

  const ranks = new Int32Array(capacity)
  ranks.fill(MISSING_RANK)

  const offsets = new Int32Array(values.length + 1)
  for (let i = 0; i < values.length; i++) {
    offsets[i + 1] = offsets[i] + (counts.get(values[i]) ?? 0)
  }

  const cursors = offsets.slice(0, values.length)
  const ordered = new Int32Array(present.length)
  for (const internalId of present) {
    const value = store.get(internalId)
    const valueIndex = indexOfValue.get(value)
    if (valueIndex === undefined) continue
    ranks[internalId] = rankOfValueIndex(valueIndex)
    ordered[cursors[valueIndex]] = internalId
    cursors[valueIndex]++
  }

  return { values, ranks, ordered, missing: Int32Array.from(missing) }
}

export function rankOfValueIndex(valueIndex: number): number {
  return valueIndex * 2 + 2
}

export function rankIsBetweenValues(rank: number): boolean {
  return rank > MISSING_RANK && rank % 2 === 1
}

export function rankOfValue(order: SortColumnOrder, value: ComparableSortValue): number {
  if (value === null) return MISSING_RANK

  const values = order.values
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const comparison = compareAscending(values[mid], value)
    if (comparison === 0) return rankOfValueIndex(mid)
    if (comparison < 0) low = mid + 1
    else high = mid
  }
  return low * 2 + 1
}

export function seekPosition(order: SortColumnOrder, rank: number, direction: 'asc' | 'desc'): number {
  const ordered = order.ordered
  const ranks = order.ranks

  let low = 0
  let high = ordered.length
  if (direction === 'asc') {
    while (low < high) {
      const mid = (low + high) >>> 1
      if (ranks[ordered[mid]] < rank) low = mid + 1
      else high = mid
    }
    return low
  }

  while (low < high) {
    const mid = (low + high) >>> 1
    if (ranks[ordered[mid]] <= rank) low = mid + 1
    else high = mid
  }
  return low - 1
}

export function estimateOrderBytes(order: SortColumnOrder): number {
  return order.ranks.length * BYTES_PER_RANK + (order.ordered.length + order.missing.length) * BYTES_PER_ORDERED_ENTRY
}
