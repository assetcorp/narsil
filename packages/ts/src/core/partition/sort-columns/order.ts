import { buildSortOrder } from '#platform/sort-value'
import { bitsetSet, createBitSet, ErrorCodes, NarsilError } from '../../../engine/optional-reads-host-bindings'
import type { NativeSortValues } from '../../../vector/native/types/sort'
import type { ComparableSortValue } from '../../ordering'
import { compareComparableValues } from '../../ordering/sort-comparison'
import { sortValueAt } from '../../sort-values/regions'
import { allocateSortValues, type ValueStore } from './values'

export const MISSING_RANK = -1

const BYTES_PER_RANK = 4
const BYTES_PER_ORDERED_ENTRY = 4

export interface SortColumnOrder {
  values: ComparableSortValue[]
  dictionary: NativeSortValues
  ranks: Int32Array
  ordered: Uint32Array
  missing: Int32Array
}

function compareAscending(a: ComparableSortValue, b: ComparableSortValue): number {
  return compareComparableValues(a, b, 'asc')
}

export function buildOrder(store: ValueStore, liveIds: Iterable<number>, capacity: number): SortColumnOrder {
  const current = store.regions(capacity)
  const live = createBitSet(capacity)
  const missing: number[] = []
  let present = 0
  let unitCount = 0
  for (const internalId of liveIds) {
    bitsetSet(live, internalId)
    const kind = current.kinds[internalId]
    if (kind === 0) {
      missing.push(internalId)
      continue
    }
    present++
    if (kind === 2) unitCount += current.textLength[internalId]
  }
  const dictionary = allocateSortValues(present, unitCount)
  const ranks = new Int32Array(capacity)
  const ordered = new Uint32Array(present)
  const dirty = createBitSet(capacity)
  const counts = new Uint32Array(2)
  const status = buildSortOrder(current, live, dictionary, ranks, ordered, dirty, counts)
  if (status !== 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The sort order could not be built', { status: -status })
  }
  const values = Array.from({ length: counts[0] }, (_, index) => sortValueAt(dictionary, index))
  return {
    values,
    dictionary: {
      kinds: dictionary.kinds.subarray(0, counts[0]),
      numbers: dictionary.numbers.subarray(0, counts[0]),
      textStart: dictionary.textStart.subarray(0, counts[0]),
      textLength: dictionary.textLength.subarray(0, counts[0]),
      units: dictionary.units,
    },
    ranks,
    ordered,
    missing: Int32Array.from(missing),
  }
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
  const dictionaryBytes = Object.values(order.dictionary).reduce((bytes, region) => bytes + region.buffer.byteLength, 0)
  return (
    dictionaryBytes +
    order.ranks.length * BYTES_PER_RANK +
    (order.ordered.length + order.missing.length) * BYTES_PER_ORDERED_ENTRY
  )
}
