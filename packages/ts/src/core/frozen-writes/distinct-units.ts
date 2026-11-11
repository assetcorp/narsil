import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import { SETTLE_KEY_SLOTS_PER_KEY } from './constants'
import { entryOrder, findUnits, tableAscends } from './table-order'
import { compareUnits, sameUnits } from './unit-order'

const EMPTY_SLOT = -1
const MISSING_ENTRY = -1
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

function slotCountFor(keys: number): number {
  let slots = 1
  while (slots < keys * SETTLE_KEY_SLOTS_PER_KEY) slots *= 2
  return slots
}

export class DistinctUnits {
  count = 0
  hits = new Uint32Array(0)
  entries = new Int32Array(0)
  private starts = new Uint32Array(0)
  private lengths = new Uint32Array(0)
  private tags = new Uint32Array(0)
  private order = new Uint32Array(0)
  private slots = new Int32Array(0)
  private mask = 0
  private units: Uint16Array = new Uint16Array(0)
  private readonly byUnits = (left: number, right: number): number =>
    compareUnits(this.units, this.starts[left], this.lengths[left], this.starts[right], this.lengths[right]) ||
    this.tags[left] - this.tags[right]

  begin(units: Uint16Array, capacity: number): void {
    this.units = units
    this.count = 0
    if (this.starts.length < capacity) {
      this.hits = new Uint32Array(capacity)
      this.entries = new Int32Array(capacity)
      this.starts = new Uint32Array(capacity)
      this.lengths = new Uint32Array(capacity)
      this.tags = new Uint32Array(capacity)
      this.order = new Uint32Array(capacity)
    }
    const slots = slotCountFor(capacity)
    if (this.slots.length < slots) this.slots = new Int32Array(slots)
    this.slots.fill(EMPTY_SLOT, 0, slots)
    this.mask = slots - 1
  }

  add(start: number, length: number, tag: number): number {
    const { units, slots, starts, lengths, tags } = this
    const mask = this.mask
    let hash = FNV_OFFSET_BASIS
    for (let at = start; at < start + length; at++) hash = Math.imul(hash ^ units[at], FNV_PRIME)
    let slot = Math.imul(hash ^ tag, FNV_PRIME) & mask
    let key = slots[slot]
    while (key !== EMPTY_SLOT && !(tags[key] === tag && sameUnits(units, starts[key], lengths[key], start, length))) {
      slot = (slot + 1) & mask
      key = slots[slot]
    }
    if (key === EMPTY_SLOT) {
      key = this.count++
      slots[slot] = key
      starts[key] = start
      lengths[key] = length
      tags[key] = tag
      this.hits[key] = 0
    }
    this.hits[key]++
    return key
  }

  resolve(table: NativeFrozenStrings, stride: number, tokens: Uint32Array | undefined): void {
    const { count, starts, lengths, tags, entries, units } = this
    if (!tableAscends(table, stride, tokens)) {
      for (let key = 0; key < count; key++)
        entries[key] = findUnits(table, units, starts[key], lengths[key], stride, tokens, tags[key])
      return
    }
    const order = this.order.subarray(0, count)
    for (let key = 0; key < count; key++) order[key] = key
    order.sort(this.byUnits)
    const size = table.counts.length
    let cursor = 0
    for (let rank = 0; rank < count; rank++) {
      const key = order[rank]
      const start = starts[key]
      const length = lengths[key]
      const tag = tags[key]
      cursor = lowerBound(table, stride, tokens, units, start, length, tag, cursor, size)
      if (cursor < size && entryOrder(table, stride, tokens, cursor, units, start, length, tag) === 0)
        entries[key] = cursor++
      else entries[key] = MISSING_ENTRY
    }
  }
}

function lowerBound(
  table: NativeFrozenStrings,
  stride: number,
  tokens: Uint32Array | undefined,
  units: Uint16Array,
  start: number,
  length: number,
  tag: number,
  cursor: number,
  size: number,
): number {
  if (cursor >= size || entryOrder(table, stride, tokens, cursor, units, start, length, tag) >= 0) return cursor
  let below = cursor
  let step = 1
  let above = cursor + 1
  while (above < size && entryOrder(table, stride, tokens, above, units, start, length, tag) < 0) {
    below = above
    step *= 2
    above = below + step
  }
  if (above > size) above = size
  while (above - below > 1) {
    const middle = below + ((above - below) >>> 1)
    if (entryOrder(table, stride, tokens, middle, units, start, length, tag) < 0) below = middle
    else above = middle
  }
  return above
}
