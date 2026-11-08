import type { NativeTermTable } from '../../vector/native/types/terms'
import { fnv1aUtf16 as stringHash } from '../hash'
import { requireRoom, SegmentRefusal } from './status'

export { stringHash }

export interface StringChange {
  text: string
  ordinal: number
  added: boolean
  slot: number
  token: number
  count: number
  points: number
  index: number
}

function equalText(table: NativeTermTable, ordinal: number, text: string): boolean {
  if (ordinal >= table.header[0] || table.termLength[ordinal] !== text.length) return false
  const start = table.termOffset[ordinal]
  if (start > table.header[4] || text.length > table.header[4] - start) return false
  for (let at = 0; at < text.length; at++) if (table.units[start + at] !== text.charCodeAt(at)) return false
  return true
}

export function findString(table: NativeTermTable, text: string): number {
  const mask = table.slots.length - 1
  let slot = stringHash(text) & mask
  for (let scanned = 0; scanned < table.slots.length; scanned++) {
    const entry = table.slots[slot]
    if (entry === 0) return -1
    if (entry > 0 && equalText(table, entry - 1, text)) return entry - 1
    slot = (slot + 1) & mask
  }
  return -1
}

export function removeString(table: NativeTermTable, entry: StringChange): void {
  const mask = table.slots.length - 1
  let slot = stringHash(entry.text) & mask
  for (let scanned = 0; scanned < table.slots.length; scanned++) {
    const held = table.slots[slot]
    if (held === 0) return
    if (held > 0 && held - 1 === entry.ordinal) {
      table.slots[slot] = -1
      if (table.header[1] > 0) table.header[1]--
      return
    }
    slot = (slot + 1) & mask
  }
}

export class StringPlan {
  readonly entries: StringChange[] = []
  private readonly byText = new Map<string, StringChange>()
  private readonly placed = new Set<number>()
  private added = 0
  private units = 0

  constructor(readonly table: NativeTermTable) {}

  prepare(text: string): StringChange {
    const held = this.byText.get(text)
    if (held !== undefined) return held
    const found = findString(this.table, text)
    const ordinal = found < 0 ? this.table.header[0] + this.added : found
    requireRoom(ordinal < 0x7fffffff && (found >= 0 || text.length <= 0xffffffff - this.units))
    const entry = {
      text,
      ordinal,
      added: found < 0,
      slot: 0,
      token: 0,
      count: 0,
      points: 0,
      index: this.entries.length,
    }
    this.entries.push(entry)
    this.byText.set(text, entry)
    if (entry.added) {
      this.added++
      this.units += text.length
    }
    return entry
  }

  check(): void {
    const table = this.table
    requireRoom(
      this.added <= table.termOffset.length - table.header[0] &&
        this.units <= table.units.length - table.header[4] &&
        this.added < table.slots.length - table.header[1],
    )
    for (const entry of this.entries) if (entry.added) this.place(entry)
  }

  publish(): void {
    const table = this.table
    let offset = table.header[4]
    for (const entry of this.entries) {
      if (!entry.added) continue
      const ordinal = entry.ordinal
      for (let at = 0; at < entry.text.length; at++) table.units[offset + at] = entry.text.charCodeAt(at)
      if (entry.text.length > 0) {
        const first = entry.text.charCodeAt(0)
        table.firstUnitNext[ordinal] = table.firstUnitHead[first]
        table.firstUnitHead[first] = ordinal + 1
      } else table.firstUnitNext[ordinal] = 0
      table.termOffset[ordinal] = offset
      table.termLength[ordinal] = entry.text.length
      table.slots[entry.slot] = ordinal + 1
      offset += entry.text.length
    }
    table.header[0] += this.added
    table.header[1] += this.added
    table.header[4] = offset
  }

  private place(entry: StringChange): void {
    const table = this.table
    const mask = table.slots.length - 1
    let slot = stringHash(entry.text) & mask
    let chosen = -1
    for (let scanned = 0; scanned < table.slots.length; scanned++) {
      if (!this.placed.has(slot) && table.slots[slot] <= 0) {
        if (chosen < 0) chosen = slot
        else if (table.slots[slot] === 0) {
          entry.slot = chosen
          this.placed.add(chosen)
          return
        }
      }
      slot = (slot + 1) & mask
    }
    throw new SegmentRefusal(3)
  }
}

export function addCount(entry: StringChange, current: number, added: number): void {
  if (current + entry.count + added > 0xffffffff) throw new SegmentRefusal(8)
  entry.count += added
}
