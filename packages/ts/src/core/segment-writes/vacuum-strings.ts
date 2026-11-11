import type { NativeSurfaceTable } from '../../vector/native/types/segments'
import { storedText } from '../stored-values/text'
import { requireSegment } from './status'
import { findString, stringHash } from './strings'

interface VacuumString {
  text: string
  offset: number
  token: number
  count: number
  points: number
}

export class StringVacuum {
  readonly mapping: Uint32Array
  private readonly entries: VacuumString[] = []
  private readonly units: Uint16Array
  private unitCount = 0

  constructor(
    private readonly table: NativeSurfaceTable,
    private readonly points: Uint32Array | null,
    tokens: Uint32Array,
  ) {
    const strings = table.strings
    this.mapping = new Uint32Array(strings.header[0]).fill(0xffffffff)
    this.units = new Uint16Array(strings.header[4])
    for (let at = 0; at < this.mapping.length; at++) {
      if (table.count[at] === 0) continue
      const offset = strings.termOffset[at]
      const length = strings.termLength[at]
      requireSegment(
        offset <= strings.header[4] &&
          length <= strings.header[4] - offset &&
          length <= strings.header[4] - this.unitCount &&
          table.token[at] < tokens.length &&
          tokens[table.token[at]] !== 0xffffffff,
      )
      const text = storedText(strings.units, offset, length)
      requireSegment(findString(strings, text) === at)
      this.mapping[at] = this.entries.length
      this.entries.push({
        text,
        offset: this.unitCount,
        token: tokens[table.token[at]],
        count: table.count[at],
        points: points?.[at] ?? 0,
      })
      this.units.set(strings.units.subarray(offset, offset + length), this.unitCount)
      this.unitCount += length
    }
    requireSegment(this.entries.length === strings.header[1] && this.entries.length < strings.slots.length)
  }

  publish(): void {
    const table = this.table
    const points = this.points
    const strings = table.strings
    strings.slots.fill(0)
    strings.firstUnitHead.fill(0)
    strings.units.set(this.units.subarray(0, this.unitCount))
    const mask = strings.slots.length - 1
    for (let at = 0; at < this.entries.length; at++) {
      const entry = this.entries[at]
      let slot = stringHash(entry.text) & mask
      while (strings.slots[slot] !== 0) slot = (slot + 1) & mask
      strings.slots[slot] = at + 1
      strings.termOffset[at] = entry.offset
      strings.termLength[at] = entry.text.length
      strings.firstUnitNext[at] = 0
      if (entry.text.length > 0) {
        const first = entry.text.charCodeAt(0)
        strings.firstUnitNext[at] = strings.firstUnitHead[first]
        strings.firstUnitHead[first] = at + 1
      }
      table.token[at] = entry.token
      table.count[at] = entry.count
      if (points !== null) points[at] = entry.points
    }
    table.count.fill(0, this.entries.length, this.mapping.length)
    strings.header[0] = strings.header[1] = this.entries.length
    strings.header[4] = this.unitCount
    strings.header[3]++
  }
}
