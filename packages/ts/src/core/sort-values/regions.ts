import type { NativeSortValues } from '../../vector/native/types/sort'
import { SORT_VALUE_MAX_CODE_POINTS } from '../ordering/constants'
import { typedRegion } from '../stored-values/regions'

export function captureSortValues(value: NativeSortValues): NativeSortValues | null {
  if (value === null || typeof value !== 'object') return null
  return {
    kinds: value.kinds,
    numbers: value.numbers,
    textStart: value.textStart,
    textLength: value.textLength,
    units: value.units,
  }
}

export function readSortRegions(value: NativeSortValues | null): NativeSortValues | null {
  if (value === null) return null
  const kinds = typedRegion(value.kinds, 'Uint8Array')
  const numbers = typedRegion(value.numbers, 'Float64Array')
  const textStart = typedRegion(value.textStart, 'Uint32Array')
  const textLength = typedRegion(value.textLength, 'Uint32Array')
  const units = typedRegion(value.units, 'Uint16Array')
  if (kinds === null || numbers === null || textStart === null || textLength === null || units === null) return null
  return { kinds, numbers, textStart, textLength, units }
}

export function validSortValue(values: NativeSortValues, ordinal: number): boolean {
  const kind = values.kinds[ordinal]
  if (kind > 4) return false
  if (kind === 1) return Number.isFinite(values.numbers[ordinal])
  if (kind !== 2) return true
  const start = values.textStart[ordinal]
  const length = values.textLength[ordinal]
  if (start > values.units.length || length > values.units.length - start) return false
  const end = start + length
  let at = start
  for (let count = 0; at < end && count < SORT_VALUE_MAX_CODE_POINTS; count++) {
    const high = values.units[at++]
    if (high >= 0xd800 && high < 0xdc00 && at < end) {
      const low = values.units[at]
      if (low >= 0xdc00 && low < 0xe000) at++
    }
  }
  return at === end
}

export function sortValueAt(values: NativeSortValues, ordinal: number): string | number | boolean | null {
  const kind = values.kinds[ordinal]
  if (kind === 1) return values.numbers[ordinal]
  if (kind === 2) {
    const start = values.textStart[ordinal]
    return String.fromCharCode(...values.units.subarray(start, start + values.textLength[ordinal]))
  }
  if (kind === 3) return false
  if (kind === 4) return true
  return null
}
