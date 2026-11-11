import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import { buildStoredValues } from './build'
import { PAYLOAD_INITIAL_CAPACITY } from './constants'
import { checkedSize, compactStoredPayload, reserveStoredValues } from './storage'

export interface StoredValueChange {
  ordinal: number
  value: unknown
}

export class StoredValueColumn {
  private held: NativeStoredValues
  private ordinals: number
  private elements: number
  private usedUnits: number
  private usedBytes: number
  private liveUnits: number
  private liveBytes: number
  private view: NativeStoredValues | null = null

  constructor(values: readonly unknown[] | NativeStoredValues) {
    this.held = 'shapes' in values ? values : buildStoredValues(values)
    this.ordinals = this.held.shapes.length
    this.elements = this.held.kinds.length
    this.usedUnits = this.liveUnits = this.held.units.length
    this.usedBytes = this.liveBytes = this.held.bytes.length
  }

  prepare(changes: readonly StoredValueChange[]): () => void {
    const prepared = changes.map(change => ({ ordinal: change.ordinal, values: buildStoredValues([change.value]) }))
    let ordinals = this.ordinals
    let elements = this.elements
    let capacity = elements
    let units = 0
    let bytes = 0
    for (const change of prepared) {
      checkedSize(change.ordinal)
      ordinals = Math.max(ordinals, change.ordinal + 1)
      const previous =
        change.ordinal < this.ordinals ? this.held.starts[change.ordinal + 1] - this.held.starts[change.ordinal] : 0
      elements += change.values.kinds.length - previous
      capacity = Math.max(capacity, checkedSize(elements))
      units += change.values.units.length
      bytes += change.values.bytes.length
    }
    let held = this.held
    let usedUnits = this.usedUnits
    let usedBytes = this.usedBytes
    if (
      (usedUnits > PAYLOAD_INITIAL_CAPACITY && usedUnits - this.liveUnits > this.liveUnits) ||
      (usedBytes > PAYLOAD_INITIAL_CAPACITY && usedBytes - this.liveBytes > this.liveBytes)
    ) {
      held = compactStoredPayload(held, this.elements, this.liveUnits, this.liveBytes, units, bytes)
      usedUnits = this.liveUnits
      usedBytes = this.liveBytes
    }
    held = reserveStoredValues(held, ordinals, capacity, usedUnits + units, usedBytes + bytes)
    return () => {
      this.view = null
      this.held = held
      this.usedUnits = usedUnits
      this.usedBytes = usedBytes
      for (const change of prepared) this.replace(change.ordinal, change.values)
    }
  }

  private replace(ordinal: number, values: NativeStoredValues): void {
    const held = this.held
    if (ordinal >= this.ordinals) {
      held.starts.fill(this.elements, this.ordinals, ordinal + 2)
      this.ordinals = ordinal + 1
    }
    const start = held.starts[ordinal]
    const end = held.starts[ordinal + 1]
    for (let at = start; at < end; at++) {
      if (held.kinds[at] === 4) this.liveUnits -= held.textLength[at]
      else if (held.kinds[at] === 5) this.liveBytes -= held.textLength[at]
    }
    const delta = values.kinds.length - (end - start)
    if (delta !== 0) {
      held.kinds.copyWithin(end + delta, end, this.elements)
      held.numbers.copyWithin(end + delta, end, this.elements)
      held.textStart.copyWithin(end + delta, end, this.elements)
      held.textLength.copyWithin(end + delta, end, this.elements)
      for (let at = ordinal + 1; at <= this.ordinals; at++) held.starts[at] += delta
      this.elements += delta
    }
    held.shapes[ordinal] = values.shapes[0]
    held.kinds.set(values.kinds, start)
    held.numbers.set(values.numbers, start)
    held.textLength.set(values.textLength, start)
    for (let at = 0; at < values.kinds.length; at++) {
      const base = values.kinds[at] === 4 ? this.usedUnits : values.kinds[at] === 5 ? this.usedBytes : 0
      held.textStart[start + at] = values.textStart[at] + base
    }
    held.units.set(values.units, this.usedUnits)
    held.bytes.set(values.bytes, this.usedBytes)
    this.usedUnits += values.units.length
    this.liveUnits += values.units.length
    this.usedBytes += values.bytes.length
    this.liveBytes += values.bytes.length
  }

  regions(): NativeStoredValues {
    if (this.view !== null) return this.view
    const held = this.held
    this.view = {
      shapes: held.shapes.subarray(0, this.ordinals),
      starts: held.starts.subarray(0, this.ordinals + 1),
      kinds: held.kinds.subarray(0, this.elements),
      numbers: held.numbers.subarray(0, this.elements),
      textStart: held.textStart.subarray(0, this.elements),
      textLength: held.textLength.subarray(0, this.elements),
      units: held.units.subarray(0, this.usedUnits),
      bytes: held.bytes.subarray(0, this.usedBytes),
    }
    return this.view
  }

  bytes(): number {
    return Object.values(this.held).reduce((sum, region) => sum + region.byteLength, 0)
  }
}
