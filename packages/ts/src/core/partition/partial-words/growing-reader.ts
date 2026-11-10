import type { NativeRunTable } from '../../../vector/native/types/segments'
import type { GrowingSegment } from '../../segment-writes/growing'
import { hashRun } from '../../segment-writes/runs'
import type { SpellingTable } from '../../segment-writes/spelling-table'
import type { PartialSpellings } from './spellings'
import type { PartialWordReader } from './types'

function runOrdinal(table: NativeRunTable, points: readonly number[]): number {
  const mask = table.slots.length - 1
  let slot = hashRun(points) & mask
  for (let scanned = 0; scanned < table.slots.length; scanned++) {
    const entry = table.slots[slot]
    if (entry === 0) return -1
    if (entry > 0) {
      const start = (entry - 1) * 3
      if (table.runs[start] === points[0] && table.runs[start + 1] === points[1] && table.runs[start + 2] === points[2])
        return entry - 1
    }
    slot = (slot + 1) & mask
  }
  return -1
}

function contains(table: SpellingTable, ordinal: number, text: string): boolean {
  const strings = table.strings
  const start = strings.termOffset[ordinal]
  const last = start + strings.termLength[ordinal] - text.length
  for (let from = start; from <= last; from++) {
    let at = 0
    while (at < text.length && strings.units[from + at] === text.charCodeAt(at)) at++
    if (at === text.length) return true
  }
  return false
}

export function growingSpellingReader(segment: GrowingSegment): PartialWordReader {
  return {
    forEachContaining(probe, visit): void {
      const table = segment.spellings
      const points = probe.codePoints
      if (table === null || points.length < 3) return
      const runs = table.runs
      const triple = [0, 0, 0]
      let narrowest = -1
      for (let at = 0; at + 3 <= points.length; at++) {
        for (let unit = 0; unit < 3; unit++) triple[unit] = points[at + unit]
        const ordinal = runOrdinal(runs, triple)
        if (ordinal < 0) return
        if (narrowest < 0 || runs.listLength[ordinal] < runs.listLength[narrowest]) narrowest = ordinal
      }
      if (narrowest < 0) return
      const start = runs.listStart[narrowest]
      const end = start + runs.listLength[narrowest]
      const terms = segment.postings.terms
      for (let at = start; at < end; at++) {
        const spelling = runs.members[at]
        if (table.count[spelling] === 0 || table.codePoints[spelling] <= points.length) continue
        if (contains(table, spelling, probe.text))
          visit(terms.tokens[table.token[spelling]], table.codePoints[spelling])
      }
    },
    bytes: () => 0,
  }
}

export function growingSpellings(segment: GrowingSegment, fields: readonly string[]): PartialSpellings {
  const encoded: PartialSpellings = { fields: [...fields], tokens: [], spellings: [], counts: [] }
  const table = segment.spellings
  if (table === null) return encoded
  const terms = segment.postings.terms
  for (const ordinal of table.liveEntries()) {
    encoded.tokens.push(terms.tokens[table.token[ordinal]])
    encoded.spellings.push(table.textAt(ordinal))
    encoded.counts.push(table.count[ordinal])
  }
  return encoded
}
