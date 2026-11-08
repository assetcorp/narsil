import { ErrorCodes, NarsilError } from '../../../errors'
import type { NativeSortValues } from '../../../vector/native/types/sort'
import type { ComparableSortValue } from '../../ordering'
import { sortValueAt } from '../../sort-values/regions'
import { SORT_TEXT_INITIAL_CAPACITY, SORT_VALUES_INITIAL_CAPACITY } from './constants'

export interface ValueStore {
  set(internalId: number, comparable: ComparableSortValue): void
  clear(internalId: number): void
  get(internalId: number): ComparableSortValue
  regions(capacity: number): NativeSortValues
  estimateBytes(): number
}

export function allocateSortValues(capacity: number, units: number): NativeSortValues {
  return {
    kinds: new Uint8Array(capacity),
    numbers: new Float64Array(capacity),
    textStart: new Uint32Array(capacity),
    textLength: new Uint32Array(capacity),
    units: new Uint16Array(units),
  }
}

export function createValueStore(): ValueStore {
  let held = allocateSortValues(0, 0)
  let usedUnits = 0
  let liveUnits = 0

  function grow(capacity: number): void {
    if (capacity <= held.kinds.length) return
    const next = allocateSortValues(Math.max(capacity, held.kinds.length * 2, SORT_VALUES_INITIAL_CAPACITY), 0)
    next.kinds.set(held.kinds)
    next.numbers.set(held.numbers)
    next.textStart.set(held.textStart)
    next.textLength.set(held.textLength)
    next.units = held.units
    held = next
  }

  function compact(): void {
    const units = new Uint16Array(Math.max(liveUnits, SORT_TEXT_INITIAL_CAPACITY))
    let at = 0
    for (let ordinal = 0; ordinal < held.kinds.length; ordinal++) {
      if (held.kinds[ordinal] !== 2) continue
      const start = held.textStart[ordinal]
      const length = held.textLength[ordinal]
      units.set(held.units.subarray(start, start + length), at)
      held.textStart[ordinal] = at
      at += length
    }
    held.units = units
    usedUnits = at
  }

  function reserveText(length: number): void {
    if (usedUnits - liveUnits > liveUnits && usedUnits > SORT_TEXT_INITIAL_CAPACITY) compact()
    const needed = usedUnits + length
    if (needed > 0xffffffff) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The sort strings exceed the native value layout')
    }
    if (needed <= held.units.length) return
    const units = new Uint16Array(
      Math.max(needed, Math.min(0xffffffff, held.units.length * 2), SORT_TEXT_INITIAL_CAPACITY),
    )
    units.set(held.units.subarray(0, usedUnits))
    held.units = units
  }

  return {
    set(internalId, value) {
      grow(internalId + 1)
      const isText = held.kinds[internalId] === 2
      const oldLength = isText ? held.textLength[internalId] : 0
      if (typeof value === 'string') {
        if (!isText || value.length > oldLength) reserveText(value.length)
        const start = isText && value.length <= oldLength ? held.textStart[internalId] : usedUnits
        if (!isText || value.length > oldLength) usedUnits += value.length
        for (let index = 0; index < value.length; index++) held.units[start + index] = value.charCodeAt(index)
        held.textStart[internalId] = start
        held.textLength[internalId] = value.length
        held.kinds[internalId] = 2
        liveUnits += value.length - oldLength
        return
      }
      liveUnits -= oldLength
      held.textStart[internalId] = 0
      held.textLength[internalId] = 0
      held.kinds[internalId] = value === null ? 0 : typeof value === 'number' ? 1 : value ? 4 : 3
      held.numbers[internalId] = typeof value === 'number' ? value : 0
    },
    clear(internalId) {
      if (internalId >= held.kinds.length) return
      if (held.kinds[internalId] === 2) liveUnits -= held.textLength[internalId]
      held.kinds[internalId] = 0
      held.textStart[internalId] = 0
      held.textLength[internalId] = 0
    },
    get(internalId) {
      return internalId >= held.kinds.length ? null : sortValueAt(held, internalId)
    },
    regions(capacity) {
      grow(capacity)
      return {
        kinds: held.kinds.subarray(0, capacity),
        numbers: held.numbers.subarray(0, capacity),
        textStart: held.textStart.subarray(0, capacity),
        textLength: held.textLength.subarray(0, capacity),
        units: held.units.subarray(0, usedUnits),
      }
    },
    estimateBytes() {
      return Object.values(held).reduce((bytes, region) => bytes + region.byteLength, 0)
    },
  }
}
