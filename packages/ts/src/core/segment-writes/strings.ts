import type { NativeSurfaceTable } from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'
import { fnv1aUtf16 as stringHash } from '../hash'
import { WRITE_PLAN_START_CAPACITY } from './constants'
import { requireRoom, SegmentRefusal } from './status'
import { StampedMemo } from './string-memo'
import { TextIndex } from './text-index'

export { stringHash }

const MAX_STRING_ORDINAL = 0x7fffffff
const MAX_STRING_COUNT = 0xffffffff
const ABSENT = -1

function holdsText(units: Uint16Array, start: number, text: string): boolean {
  for (let at = 0; at < text.length; at++) if (units[start + at] !== text.charCodeAt(at)) return false
  return true
}

export function findString(table: NativeTermTable, text: string, hash = stringHash(text)): number {
  const slots = table.slots
  const lengths = table.termLength
  const offsets = table.termOffset
  const count = table.header[0]
  const used = table.header[4]
  const length = text.length
  const mask = slots.length - 1
  let slot = hash & mask
  for (let scanned = 0; scanned < slots.length; scanned++) {
    const entry = slots[slot]
    if (entry === 0) return ABSENT
    const ordinal = entry - 1
    if (entry > 0 && ordinal < count && lengths[ordinal] === length) {
      const start = offsets[ordinal]
      if (start <= used && length <= used - start && holdsText(table.units, start, text)) return ordinal
    }
    slot = (slot + 1) & mask
  }
  return ABSENT
}

export function removeString(table: NativeTermTable, text: string, ordinal: number, hash = stringHash(text)): void {
  const mask = table.slots.length - 1
  let slot = hash & mask
  for (let scanned = 0; scanned < table.slots.length; scanned++) {
    const held = table.slots[slot]
    if (held === 0) return
    if (held > 0 && held - 1 === ordinal) {
      table.slots[slot] = -1
      if (table.header[1] > 0) table.header[1]--
      return
    }
    slot = (slot + 1) & mask
  }
}

export class StringPlan {
  size = 0
  readonly texts: string[] = []
  hashes = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  ordinals = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  slots = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  added = new Uint8Array(WRITE_PLAN_START_CAPACITY)
  tokens = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  counts = new Float64Array(WRITE_PLAN_START_CAPACITY)
  points = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private readonly index = new TextIndex()
  private readonly placed = new StampedMemo()
  private addedCount = 0
  private units = 0

  constructor(public table: NativeTermTable) {
    this.index.clear(this)
  }

  reset(table: NativeTermTable): this {
    this.table = table
    this.size = 0
    this.addedCount = 0
    this.units = 0
    this.index.clear(this)
    return this
  }

  find(text: string): number {
    return this.index.find(this.texts, text)
  }

  prepare(text: string, indexed = true): number {
    if (indexed) {
      const held = this.index.find(this.texts, text)
      if (held >= 0) return held
    }
    const hash = stringHash(text)
    return this.append(text, hash, findString(this.table, text, hash), indexed)
  }

  prepareExisting(text: string, indexed = true): number {
    if (indexed) {
      const held = this.index.find(this.texts, text)
      if (held >= 0) return held
    }
    const hash = stringHash(text)
    const found = findString(this.table, text, hash)
    return found < 0 ? ABSENT : this.append(text, hash, found, indexed)
  }

  prepareAbsent(text: string, hash: number): number {
    return this.append(text, hash, ABSENT, false)
  }

  private append(text: string, hash: number, found: number, indexed: boolean): number {
    const ordinal = found < 0 ? this.table.header[0] + this.addedCount : found
    requireRoom(ordinal < MAX_STRING_ORDINAL && (found >= 0 || text.length <= MAX_STRING_COUNT - this.units))
    const at = this.size
    if (at === this.ordinals.length) this.grow()
    this.texts[at] = text
    this.hashes[at] = hash
    this.ordinals[at] = ordinal
    this.slots[at] = 0
    this.added[at] = found < 0 ? 1 : 0
    this.tokens[at] = 0
    this.counts[at] = 0
    this.points[at] = 0
    this.size = at + 1
    if (indexed) this.index.insertMissed(this.texts, at)
    if (found < 0) {
      this.addedCount++
      this.units += text.length
    }
    return at
  }

  check(): void {
    const table = this.table
    requireRoom(
      this.addedCount <= table.termOffset.length - table.header[0] &&
        this.units <= table.units.length - table.header[4] &&
        this.addedCount < table.slots.length - table.header[1],
    )
    if (this.addedCount === 0) return
    this.placed.claim(this, table.slots.length)
    for (let at = 0; at < this.size; at++) if (this.added[at] === 1) this.place(at)
  }

  publish(): void {
    const table = this.table
    let offset = table.header[4]
    for (let at = 0; at < this.size; at++) {
      if (this.added[at] === 0) continue
      const text = this.texts[at]
      const ordinal = this.ordinals[at]
      for (let unit = 0; unit < text.length; unit++) table.units[offset + unit] = text.charCodeAt(unit)
      if (text.length > 0) {
        const first = text.charCodeAt(0)
        table.firstUnitNext[ordinal] = table.firstUnitHead[first]
        table.firstUnitHead[first] = ordinal + 1
      } else table.firstUnitNext[ordinal] = 0
      table.termOffset[ordinal] = offset
      table.termLength[ordinal] = text.length
      table.slots[this.slots[at]] = ordinal + 1
      offset += text.length
    }
    table.header[0] += this.addedCount
    table.header[1] += this.addedCount
    table.header[4] = offset
  }

  private place(at: number): void {
    const table = this.table
    const mask = table.slots.length - 1
    let slot = this.hashes[at] & mask
    let chosen = ABSENT
    for (let scanned = 0; scanned < table.slots.length; scanned++) {
      if (this.placed.get(slot) < 0 && table.slots[slot] <= 0) {
        if (chosen < 0) chosen = slot
        else if (table.slots[slot] === 0) {
          this.slots[at] = chosen
          this.placed.set(chosen, at)
          return
        }
      }
      slot = (slot + 1) & mask
    }
    throw new SegmentRefusal(3)
  }

  private grow(): void {
    const capacity = this.ordinals.length * 2
    this.hashes = grownColumn(this.hashes, new Uint32Array(capacity))
    this.ordinals = grownColumn(this.ordinals, new Uint32Array(capacity))
    this.slots = grownColumn(this.slots, new Uint32Array(capacity))
    this.added = grownColumn(this.added, new Uint8Array(capacity))
    this.tokens = grownColumn(this.tokens, new Uint32Array(capacity))
    this.counts = grownColumn(this.counts, new Float64Array(capacity))
    this.points = grownColumn(this.points, new Uint32Array(capacity))
  }
}

function grownColumn<Column extends Uint8Array | Uint32Array | Float64Array>(held: Column, grown: Column): Column {
  grown.set(held)
  return grown
}

export function publishSurfaces(plan: StringPlan, table: NativeSurfaceTable): void {
  plan.publish()
  for (let at = 0; at < plan.size; at++) {
    const ordinal = plan.ordinals[at]
    table.token[ordinal] = plan.tokens[at]
    table.count[ordinal] = (plan.added[at] === 1 ? 0 : table.count[ordinal]) + plan.counts[at]
  }
}

export function addCount(plan: StringPlan, at: number, current: number, added: number): void {
  if (current + plan.counts[at] + added > MAX_STRING_COUNT) throw new SegmentRefusal(8)
  plan.counts[at] += added
}
