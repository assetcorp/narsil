import {
  regionsOverlap,
  SORT_VALUE_MAX_CODE_POINTS,
  truncateSortString,
  typedRegion,
} from '../../engine/optional-reads-host-bindings'
import type { NativeSortColumn, NativeSortCore, NativeSortValues } from '../../vector/native/types/sort'
import { compareComparableValues } from '../ordering/sort-comparison'
import { captureSortValues, readSortRegions, sortValueAt, validSortValue } from './regions'

function captureColumn(column: NativeSortColumn) {
  if (column === null || typeof column !== 'object') return null
  return {
    current: captureSortValues(column.current),
    values: captureSortValues(column.values),
    ranks: column.ranks,
    ordered: column.ordered,
    dirty: column.dirty,
  }
}

function validShape(values: NativeSortValues): boolean {
  const count = values.kinds.length
  return (
    count <= 0xffffffff &&
    values.numbers.length === count &&
    values.textStart.length === count &&
    values.textLength.length === count &&
    values.units.length <= 0xffffffff
  )
}

function boundText(units: Uint16Array | null): string | null {
  return units === null
    ? null
    : truncateSortString(String.fromCharCode(...units.subarray(0, SORT_VALUE_MAX_CODE_POINTS * 2)))
}

export const textRange: NativeSortCore['textRange'] = (
  columnInput,
  lowerInput,
  lowerInclusive,
  upperInput,
  upperInclusive,
  liveInput,
  outputInput,
) => {
  const held = captureColumn(columnInput)
  if (held === null || typeof lowerInclusive !== 'boolean' || typeof upperInclusive !== 'boolean') return -1
  const current = readSortRegions(held.current)
  const values = readSortRegions(held.values)
  const ranks = typedRegion(held.ranks, 'Int32Array')
  const ordered = typedRegion(held.ordered, 'Uint32Array')
  const dirty = typedRegion(held.dirty, 'Uint32Array')
  const live = typedRegion(liveInput, 'Uint32Array')
  const output = typedRegion(outputInput, 'Uint32Array')
  const lowerUnits = lowerInput === null ? null : typedRegion(lowerInput, 'Uint16Array')
  const upperUnits = upperInput === null ? null : typedRegion(upperInput, 'Uint16Array')
  if (
    current === null ||
    values === null ||
    ranks === null ||
    ordered === null ||
    dirty === null ||
    live === null ||
    output === null ||
    (lowerUnits === null && lowerInput !== null) ||
    (upperUnits === null && upperInput !== null)
  )
    return -1
  if (
    !validShape(current) ||
    !validShape(values) ||
    values.kinds.length > 0x3fffffff ||
    ranks.length > current.kinds.length ||
    ordered.length > 0xffffffff ||
    (lowerUnits !== null && lowerUnits.length > 0x40000000) ||
    (upperUnits !== null && upperUnits.length > 0x40000000)
  )
    return -1
  const inputs = [...Object.values(current), ...Object.values(values), ranks, ordered, dirty, live]
  if (lowerUnits !== null) inputs.push(lowerUnits)
  if (upperUnits !== null) inputs.push(upperUnits)
  if (inputs.some(input => regionsOverlap(input, output))) return -1
  const count = current.kinds.length
  const words = Math.max(1, Math.ceil(count / 32))
  if (live.length < words || dirty.length < words) return -1
  for (let index = 0; index < values.kinds.length; index++) {
    if (!validSortValue(values, index) || values.kinds[index] === 0) return -1
  }
  if (output.length < words) return -3
  const lower = boundText(lowerUnits)
  const upper = boundText(upperUnits)
  const position = (bound: string, afterEqual: boolean): number => {
    let low = 0
    let high = values.kinds.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      const comparison = compareComparableValues(sortValueAt(values, middle), bound, 'asc')
      if (comparison < 0 || (comparison === 0 && afterEqual)) low = middle + 1
      else high = middle
    }
    return low
  }
  const seek = (valueIndex: number): number => {
    let low = 0
    let high = ordered.length
    const rank = valueIndex * 2 + 2
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      const ordinal = ordered[middle]
      if (ordinal < ranks.length && ranks[ordinal] >= 0 && ranks[ordinal] < rank) low = middle + 1
      else high = middle
    }
    return low
  }
  const start = lower === null ? 0 : seek(position(lower, !lowerInclusive))
  const end = upper === null ? ordered.length : seek(position(upper, upperInclusive))
  output.fill(0, 0, words)
  for (let at = start; at < end; at++) {
    const ordinal = ordered[at]
    const word = ordinal >>> 5
    const bit = 1 << (ordinal & 31)
    if (
      ordinal < count &&
      ordinal < ranks.length &&
      ranks[ordinal] >= 2 &&
      (ranks[ordinal] & 1) === 0 &&
      ranks[ordinal] / 2 <= values.kinds.length &&
      (dirty[word] & bit) === 0 &&
      (live[word] & bit) !== 0
    )
      output[word] |= bit
  }
  for (let word = 0; word < words; word++) {
    let pending = dirty[word] & live[word]
    while (pending !== 0) {
      const bit = 31 - Math.clz32(pending & -pending)
      pending &= pending - 1
      const ordinal = word * 32 + bit
      if (ordinal >= count || !validSortValue(current, ordinal) || current.kinds[ordinal] === 0) continue
      const value = sortValueAt(current, ordinal)
      const lowerOrder = lower === null ? 1 : compareComparableValues(value, lower, 'asc')
      const upperOrder = upper === null ? -1 : compareComparableValues(value, upper, 'asc')
      if (
        (lowerOrder > 0 || (lowerOrder === 0 && lowerInclusive)) &&
        (upperOrder < 0 || (upperOrder === 0 && upperInclusive))
      )
        output[word] |= 1 << bit
    }
  }
  return 0
}
