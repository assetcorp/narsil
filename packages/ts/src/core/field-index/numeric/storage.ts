import { ErrorCodes, NarsilError } from '../../../errors'
import type { NumericIndexEntry } from '../../../types/internal'
import { PENDING_REMOVAL_MERGE_DIVISOR, PENDING_REMOVAL_MERGE_FLOOR } from '../../constants'
import { NUMERIC_INITIAL_CAPACITY, REMOVAL_ENTRY_BYTES } from './constants'

export interface NumericRegions {
  values: Float64Array
  ordinals: Uint32Array
}

interface Entries extends NumericRegions {
  length: number
}

interface Removal {
  value: number
  limits: number[]
  next: number
}

function empty(): Entries {
  return { values: new Float64Array(0), ordinals: new Uint32Array(0), length: 0 }
}

function grow(entries: Entries, needed: number): void {
  if (needed <= entries.values.length) return
  if (needed > 0xffffffff)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The numeric entries exceed the field layout')
  const capacity = Math.max(needed, Math.min(0xffffffff, entries.values.length * 2), NUMERIC_INITIAL_CAPACITY)
  const values = new Float64Array(capacity)
  const ordinals = new Uint32Array(capacity)
  values.set(entries.values.subarray(0, entries.length))
  ordinals.set(entries.ordinals.subarray(0, entries.length))
  entries.values = values
  entries.ordinals = ordinals
}

export function lowerBound(values: Float64Array, value: number, length = values.length): number {
  let low = 0
  let high = length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (values[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

function removeEntries(
  entries: Entries,
  from: number,
  removals: ReadonlyMap<number, Removal[]>,
  pending: boolean,
): void {
  let write = from
  for (let read = from; read < entries.length; read++) {
    const ordinal = entries.ordinals[read]
    const value = entries.values[read]
    const removal = removals.get(ordinal)?.find(entry => entry.value === value)
    if (removal !== undefined) {
      if (pending) {
        while (removal.next < removal.limits.length && removal.limits[removal.next] <= read) removal.next++
      }
      if (removal.next < removal.limits.length) {
        removal.next++
        continue
      }
    }
    entries.values[write] = value
    entries.ordinals[write++] = ordinal
  }
  entries.length = write
}

export function createNumericStorage() {
  let entries = empty()
  let pending = empty()
  const removedOrdinals: number[] = []
  const removedValues: number[] = []
  const removedLimits: number[] = []

  function discardRemovals(): void {
    removedOrdinals.length = 0
    removedValues.length = 0
    removedLimits.length = 0
  }

  function applyRemovals(): void {
    const removals = new Map<number, Removal[]>()
    let lowest = removedValues[0]
    for (let at = 0; at < removedOrdinals.length; at++) {
      const ordinal = removedOrdinals[at]
      const value = removedValues[at]
      if (value < lowest) lowest = value
      const held = removals.get(ordinal)
      const same = held?.find(entry => entry.value === value)
      if (same !== undefined) same.limits.push(removedLimits[at])
      else {
        const removal: Removal = { value, limits: [removedLimits[at]], next: 0 }
        if (held === undefined) removals.set(ordinal, [removal])
        else held.push(removal)
      }
    }
    removeEntries(entries, lowerBound(entries.values, lowest, entries.length), removals, false)
    removeEntries(pending, 0, removals, true)
    discardRemovals()
  }

  function ensureSorted(): void {
    if (removedOrdinals.length > 0) applyRemovals()
    if (pending.length === 0) return
    const order = Uint32Array.from({ length: pending.length }, (_, index) => index)
    order.sort((left, right) => pending.values[left] - pending.values[right])
    grow(entries, entries.length + pending.length)
    let left = entries.length - 1
    let right = pending.length - 1
    let write = entries.length + pending.length - 1
    while (right >= 0) {
      const next = order[right]
      if (left >= 0 && entries.values[left] > pending.values[next]) {
        entries.values[write] = entries.values[left]
        entries.ordinals[write--] = entries.ordinals[left--]
      } else {
        entries.values[write] = pending.values[next]
        entries.ordinals[write--] = pending.ordinals[next]
        right--
      }
    }
    entries.length += pending.length
    pending.length = 0
  }

  function regions(): NumericRegions {
    ensureSorted()
    return {
      values: entries.values.subarray(0, entries.length),
      ordinals: entries.ordinals.subarray(0, entries.length),
    }
  }

  return {
    regions,
    ensureSorted,
    bytes(): number {
      return (
        entries.values.byteLength +
        entries.ordinals.byteLength +
        pending.values.byteLength +
        pending.ordinals.byteLength +
        removedOrdinals.length * REMOVAL_ENTRY_BYTES
      )
    },
    insert(ordinal: number, value: number): void {
      grow(pending, pending.length + 1)
      pending.values[pending.length] = value
      pending.ordinals[pending.length++] = ordinal
    },
    remove(ordinal: number, value: number): void {
      removedOrdinals.push(ordinal)
      removedValues.push(value)
      removedLimits.push(pending.length)
      const held = entries.length + pending.length
      if (removedOrdinals.length >= Math.max(PENDING_REMOVAL_MERGE_FLOOR, held / PENDING_REMOVAL_MERGE_DIVISOR))
        ensureSorted()
    },
    clear(): void {
      entries = empty()
      pending = empty()
      discardRemovals()
    },
    deserialize(data: NumericIndexEntry[]): void {
      const next = empty()
      grow(next, data.length)
      for (let at = 0; at < data.length; at++) {
        next.values[at] = data[at].value
        next.ordinals[at] = data[at].docId
      }
      next.length = data.length
      entries = next
      pending = empty()
      discardRemovals()
    },
  }
}
