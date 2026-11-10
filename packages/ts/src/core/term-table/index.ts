import { ErrorCodes, NarsilError } from '../../errors'
import { FNV_OFFSET_BASIS, FNV_PRIME, fnv1aUtf16 as hashTerm } from '../hash'
import {
  TERM_REGION_GROWTH_FACTOR,
  TERM_SLOT_LOAD_DENOMINATOR,
  TERM_SLOT_LOAD_NUMERATOR,
  TERM_UNITS_START_CAPACITY,
} from './constants'

const COUNT = 0
const LIVE_COUNT = 1
const SLOT_CAPACITY = 2
const GENERATION = 3
const UNITS_USED = 4
const HEADER_WORDS = 8
const FIRST_UNIT_COUNT = 0x10000
const LAST_SLOT_ORDINAL = 0x7ffffffe
const LAST_OFFSET = 0xffffffff
const LAST_SLOT_CAPACITY = 0x80000000

function capacityFor(current: number, needed: number): number {
  return Math.max(needed, Math.min(LAST_OFFSET, current * TERM_REGION_GROWTH_FACTOR))
}

export class TermTable {
  readonly header = new Uint32Array(HEADER_WORDS)
  slots: Int32Array
  termOffset: Uint32Array
  termLength: Uint32Array
  firstUnitNext: Uint32Array
  readonly firstUnitHead = new Uint32Array(FIRST_UNIT_COUNT)
  units = new Uint16Array(TERM_UNITS_START_CAPACITY)
  private occupied = 0
  private accountedCount = 0

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity >= LAST_SLOT_CAPACITY)
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The term table capacity exceeds its slot layout')
    let slots = 2
    while (slots <= capacity) slots *= TERM_REGION_GROWTH_FACTOR
    this.slots = new Int32Array(slots)
    this.header[SLOT_CAPACITY] = slots
    this.termOffset = new Uint32Array(capacity)
    this.termLength = new Uint32Array(capacity)
    this.firstUnitNext = new Uint32Array(capacity)
  }

  get(token: string): number | undefined {
    const slot = this.find(token)
    return slot < 0 ? undefined : this.slots[slot] - 1
  }

  has(token: string): boolean {
    return this.find(token) >= 0
  }

  set(token: string, ordinal: number): void {
    const found = this.find(token)
    if (found >= 0) {
      if (this.slots[found] - 1 !== ordinal)
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A term already has another ordinal')
      return
    }
    const end = this.header[UNITS_USED] + token.length
    if (
      !Number.isInteger(ordinal) ||
      ordinal !== this.header[COUNT] ||
      ordinal > LAST_SLOT_ORDINAL ||
      end > LAST_OFFSET
    )
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The term does not fit its table regions')
    this.reserve(ordinal + 1, end)
    const mask = this.slots.length - 1
    let slot = hashTerm(token) & mask
    while (this.slots[slot] > 0) slot = (slot + 1) & mask
    if (this.slots[slot] === 0) this.occupied++
    const offset = this.header[UNITS_USED]
    for (let at = 0; at < token.length; at++) this.units[offset + at] = token.charCodeAt(at)
    this.termOffset[ordinal] = offset
    this.termLength[ordinal] = token.length
    if (token.length > 0) {
      const first = token.charCodeAt(0)
      this.firstUnitNext[ordinal] = this.firstUnitHead[first]
      this.firstUnitHead[first] = ordinal + 1
    }
    this.slots[slot] = ordinal + 1
    this.header[COUNT] = ordinal + 1
    this.accountedCount = ordinal + 1
    this.header[LIVE_COUNT]++
    this.header[UNITS_USED] = end
  }

  delete(token: string): void {
    const slot = this.find(token)
    if (slot < 0) return
    this.slots[slot] = -1
    this.header[LIVE_COUNT]--
  }

  setGeneration(generation: number): void {
    this.header[GENERATION] = generation
  }

  acceptCompaction(): void {
    this.occupied = this.header[LIVE_COUNT]
    this.accountedCount = this.header[COUNT]
  }

  trim(minimum: number): void {
    const count = Math.max(minimum, this.header[COUNT])
    let capacity = 2
    while (count * TERM_SLOT_LOAD_DENOMINATOR >= capacity * TERM_SLOT_LOAD_NUMERATOR)
      capacity *= TERM_REGION_GROWTH_FACTOR
    const slots = capacity < this.slots.length ? this.rehash(capacity) : this.slots
    const offsets = this.termOffset.slice(0, count)
    const lengths = this.termLength.slice(0, count)
    const next = this.firstUnitNext.slice(0, count)
    const units = this.units.slice(0, Math.max(TERM_UNITS_START_CAPACITY, this.header[UNITS_USED]))
    this.slots = slots
    this.header[SLOT_CAPACITY] = slots.length
    this.termOffset = offsets
    this.termLength = lengths
    this.firstUnitNext = next
    this.units = units
    this.acceptCompaction()
  }

  byteLength(): number {
    return (
      this.header.byteLength +
      this.slots.byteLength +
      this.termOffset.byteLength +
      this.termLength.byteLength +
      this.firstUnitNext.byteLength +
      this.firstUnitHead.byteLength +
      this.units.byteLength
    )
  }

  private find(token: string): number {
    const mask = this.slots.length - 1
    let slot = hashTerm(token) & mask
    for (let scanned = 0; scanned < this.slots.length; scanned++) {
      const entry = this.slots[slot]
      if (entry === 0) return -1
      if (entry > 0 && this.equal(entry - 1, token)) return slot
      slot = (slot + 1) & mask
    }
    return -1
  }

  private equal(ordinal: number, token: string): boolean {
    if (this.termLength[ordinal] !== token.length) return false
    const offset = this.termOffset[ordinal]
    for (let at = 0; at < token.length; at++) if (this.units[offset + at] !== token.charCodeAt(at)) return false
    return true
  }

  reserve(terms: number, units: number): void {
    const count = this.header[COUNT]
    const occupied = Math.min(this.slots.length, this.occupied + Math.max(0, count - this.accountedCount))
    if (
      Number.isInteger(terms) &&
      terms >= count &&
      terms <= this.termOffset.length &&
      Number.isInteger(units) &&
      units >= this.header[UNITS_USED] &&
      units <= this.units.length &&
      (occupied + terms - count) * TERM_SLOT_LOAD_DENOMINATOR < this.slots.length * TERM_SLOT_LOAD_NUMERATOR
    ) {
      this.occupied = occupied
      this.accountedCount = count
      return
    }
    this.prepareCapacity(terms, units).apply()
  }

  prepareCapacity(terms: number, units: number): { capacity: number; apply(): void } {
    if (
      !Number.isInteger(terms) ||
      terms < this.header[COUNT] ||
      terms > LAST_SLOT_ORDINAL + 1 ||
      !Number.isInteger(units) ||
      units < this.header[UNITS_USED] ||
      units > LAST_OFFSET
    )
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The term does not fit its table regions')
    const count = this.header[COUNT]
    let occupied = Math.min(this.slots.length, this.occupied + Math.max(0, count - this.accountedCount))
    const added = terms - count
    let offsets = this.termOffset
    let lengths = this.termLength
    let next = this.firstUnitNext
    let text = this.units
    if (terms > offsets.length) {
      const capacity = Math.min(LAST_SLOT_ORDINAL + 1, capacityFor(offsets.length, terms))
      offsets = new Uint32Array(capacity)
      lengths = new Uint32Array(capacity)
      next = new Uint32Array(capacity)
      offsets.set(this.termOffset)
      lengths.set(this.termLength)
      next.set(this.firstUnitNext)
    }
    if (units > text.length) {
      text = new Uint16Array(capacityFor(text.length, units))
      text.set(this.units)
    }
    let slots = this.slots
    if ((occupied + added) * TERM_SLOT_LOAD_DENOMINATOR >= slots.length * TERM_SLOT_LOAD_NUMERATOR) {
      const live = this.header[LIVE_COUNT] + added
      let capacity = this.slots.length
      while (live * TERM_SLOT_LOAD_DENOMINATOR >= capacity * TERM_SLOT_LOAD_NUMERATOR) {
        capacity *= TERM_REGION_GROWTH_FACTOR
        if (capacity > LAST_SLOT_CAPACITY)
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The term table capacity exceeds its slot layout')
      }
      slots = this.rehash(capacity)
      occupied = this.header[LIVE_COUNT]
    }
    return {
      capacity: offsets.length,
      apply: () => {
        this.termOffset = offsets
        this.termLength = lengths
        this.firstUnitNext = next
        this.units = text
        this.slots = slots
        this.header[SLOT_CAPACITY] = slots.length
        this.occupied = occupied
        this.accountedCount = count
      },
    }
  }

  private rehash(capacity: number): Int32Array {
    if (capacity > LAST_SLOT_CAPACITY)
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The term table capacity exceeds its slot layout')
    const slots = new Int32Array(capacity)
    const mask = capacity - 1
    for (const entry of this.slots) {
      if (entry <= 0) continue
      const ordinal = entry - 1
      const start = this.termOffset[ordinal]
      const end = start + this.termLength[ordinal]
      let hash = FNV_OFFSET_BASIS
      for (let at = start; at < end; at++) {
        const unit = this.units[at]
        hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME)
        hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME)
      }
      let slot = hash & mask
      while (slots[slot] !== 0) slot = (slot + 1) & mask
      slots[slot] = entry
    }
    return slots
  }
}
