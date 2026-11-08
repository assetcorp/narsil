import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'
import {
  POOL_VACUUM_FREE_FRACTION,
  POOL_VACUUM_MIN_FREE_ENTRIES,
  POSITION_VACUUM_MIN_FREE_VALUES,
  TERM_VACUUM_MIN_DEAD_TERMS,
} from '../inverted-index/constants'
import { prepareSpellingVacuum } from '../partition/partial-words/registry'
import { storedText } from '../stored-values/text'
import { sparseStrings } from './maintenance'
import { rowRemoved } from './postings'
import { requireSegment } from './status'
import { findString, stringHash } from './strings'
import { StringVacuum } from './vacuum-strings'

interface VacuumTerm {
  text: string
  textStart: number
  rowStart: number
  length: number
  frequency: number
  revision: number
  occurrences: number
  surfaces: number
  sliceClass: number
  flags: number
}

function needed(segment: NativeGrowingSegment): boolean {
  const count = segment.terms.header[0]
  const live = segment.terms.header[1]
  if (count - live >= TERM_VACUUM_MIN_DEAD_TERMS && count - live > live) return true
  if (sparseStrings(segment.surfaces) || sparseStrings(segment.spellings)) return true
  const allocation = segment.postings.allocation
  if (allocation[1] >= POOL_VACUUM_MIN_FREE_ENTRIES && allocation[1] > allocation[0] * POOL_VACUUM_FREE_FRACTION)
    return true
  const positions = segment.positions?.allocation
  if (
    positions !== undefined &&
    positions[1] >= POSITION_VACUUM_MIN_FREE_VALUES &&
    positions[1] > positions[0] * POOL_VACUUM_FREE_FRACTION
  )
    return true
  let empty = 0
  for (let at = 0; at < count; at++) if (segment.columns.docFrequency[at] === segment.columns.deadDocuments[at]) empty++
  return empty >= TERM_VACUUM_MIN_DEAD_TERMS && empty > count - empty
}

export function prepareVacuum(segment: NativeGrowingSegment): VacuumPlan | null {
  return needed(segment) ? new VacuumPlan(segment) : null
}

class VacuumPlan {
  private readonly mapping: Uint32Array
  private readonly terms: VacuumTerm[] = []
  private readonly docs: Uint32Array
  private readonly frequencies: Uint16Array
  private readonly fields: Uint16Array
  private readonly starts: Uint32Array
  private readonly positions: Uint32Array
  private readonly units: Uint16Array
  private rowCount = 0
  private unitCount = 0
  private positionCount: number
  private readonly surfaces: StringVacuum | null
  private readonly spellings: StringVacuum | null
  private readonly publishRuns: (() => void) | null

  constructor(private readonly segment: NativeGrowingSegment) {
    const count = segment.terms.header[0]
    const rows = segment.postings.allocation[0]
    this.mapping = new Uint32Array(count).fill(0xffffffff)
    this.docs = new Uint32Array(rows)
    this.frequencies = new Uint16Array(rows)
    this.fields = new Uint16Array(rows)
    this.starts = new Uint32Array(rows)
    this.positions = new Uint32Array(segment.positions?.allocation[0] ?? 0)
    this.positionCount = segment.positions === null ? 0 : 1
    this.units = new Uint16Array(segment.terms.header[4])
    this.validateColumns()
    for (let at = 0; at < count; at++) {
      if (
        (segment.columns.flags[at] & 1) === 0 ||
        segment.columns.docFrequency[at] === segment.columns.deadDocuments[at]
      )
        continue
      this.collectTerm(at)
    }
    requireSegment(this.terms.length < segment.terms.slots.length)
    this.surfaces = segment.surfaces === null ? null : new StringVacuum(segment.surfaces, null, this.mapping)
    this.spellings =
      segment.spellings === null
        ? null
        : new StringVacuum(segment.spellings, segment.spellings.codePoints, this.mapping)
    this.publishRuns =
      segment.spellings === null || this.spellings === null
        ? null
        : prepareSpellingVacuum(segment.spellings.runs, this.spellings.mapping)
  }

  private validateColumns(): void {
    const { columns, postings, terms } = this.segment
    const end = postings.allocation[0]
    const slices: Array<{ start: number; length: number }> = []
    let live = 0
    for (let at = 0; at < this.mapping.length; at++) {
      if ((columns.flags[at] & 1) === 0) continue
      live++
      requireSegment(
        columns.docFrequency[at] >= columns.deadDocuments[at] &&
          columns.docFrequency[at] <= columns.lengths[at] &&
          Number.isFinite(columns.totalTermFrequency[at]) &&
          columns.totalTermFrequency[at] >= 0 &&
          Number.isFinite(columns.surfaceOccurrences[at]) &&
          columns.surfaceOccurrences[at] >= 0,
      )
      const kind = columns.sliceClass[at]
      if (kind === 255 && columns.lengths[at] === 0) continue
      const start = columns.sliceStart[at]
      requireSegment(kind < postings.sliceCapacities.length && start <= end)
      const length = postings.sliceCapacities[kind]
      requireSegment(length <= end - start && columns.lengths[at] <= length)
      slices.push({ start, length })
    }
    requireSegment(live === terms.header[1])
    slices.sort((left, right) => left.start - right.start)
    for (let at = 1; at < slices.length; at++)
      requireSegment(slices[at].start - slices[at - 1].start >= slices[at - 1].length)
  }

  private collectTerm(ordinal: number): void {
    const { terms, columns } = this.segment
    const start = terms.termOffset[ordinal]
    const length = terms.termLength[ordinal]
    requireSegment(
      start <= terms.header[4] && length <= terms.header[4] - start && length <= terms.header[4] - this.unitCount,
    )
    const text = storedText(terms.units, start, length)
    requireSegment(findString(terms, text) === ordinal)
    const term: VacuumTerm = {
      text,
      textStart: this.unitCount,
      rowStart: this.rowCount,
      length: 0,
      frequency: columns.docFrequency[ordinal] - columns.deadDocuments[ordinal],
      revision: (columns.revision[ordinal] + 1) >>> 0,
      occurrences: columns.totalTermFrequency[ordinal],
      surfaces: columns.surfaceOccurrences[ordinal],
      sliceClass: 0,
      flags: columns.flags[ordinal] | 2,
    }
    this.units.set(terms.units.subarray(start, start + length), this.unitCount)
    this.unitCount += length
    this.collectRows(term, ordinal)
    this.mapping[ordinal] = this.terms.length
    this.terms.push(term)
  }

  private collectRows(term: VacuumTerm, ordinal: number): void {
    const { columns, postings } = this.segment
    const start = columns.sliceStart[ordinal]
    let last = 0
    for (let at = start; at < start + columns.lengths[ordinal]; at++) {
      const doc = postings.docIds[at]
      requireSegment(
        doc < this.segment.ordinalCapacity && postings.fieldIndices[at] < this.segment.partialFields.length,
      )
      if (rowRemoved(this.segment, doc)) continue
      requireSegment(this.rowCount < this.docs.length)
      const target = this.rowCount++
      this.docs[target] = doc
      this.frequencies[target] = postings.frequencies[at]
      this.fields[target] = postings.fieldIndices[at]
      if (term.length > 0 && doc < last) term.flags &= ~2
      last = doc
      term.length++
      if (this.segment.positions !== null && (term.flags & 4) !== 0) this.collectPositions(at, target)
    }
    requireSegment(term.length > 0 && term.frequency <= term.length)
    while (term.sliceClass < postings.sliceCapacities.length && postings.sliceCapacities[term.sliceClass] < term.length)
      term.sliceClass++
    requireSegment(term.sliceClass < postings.sliceCapacities.length)
    const length = postings.sliceCapacities[term.sliceClass]
    requireSegment(length <= postings.allocation[0] - term.rowStart)
    this.rowCount = term.rowStart + length
  }

  private collectPositions(source: number, target: number): void {
    const { positions, postings } = this.segment
    if (positions === null || postings.positionStarts === null) return
    const offset = postings.positionStarts[source]
    if (offset === 0) return
    const end = positions.allocation[0]
    requireSegment(offset < end && positions.values[offset] < end - offset)
    const length = positions.values[offset] + 1
    requireSegment(this.positionCount <= end && length <= end - this.positionCount)
    this.starts[target] = this.positionCount
    this.positions.set(positions.values.subarray(offset, offset + length), this.positionCount)
    this.positionCount += length
  }

  publish(): void {
    const { terms, columns, postings, positions } = this.segment
    terms.slots.fill(0)
    terms.firstUnitHead.fill(0)
    terms.units.set(this.units.subarray(0, this.unitCount))
    for (let at = 0; at < this.terms.length; at++) {
      const term = this.terms[at]
      this.publishTerm(terms, term, at)
      columns.sliceStart[at] = term.rowStart
      columns.sliceClass[at] = term.sliceClass
      columns.lengths[at] = term.length
      columns.docFrequency[at] = term.frequency
      columns.deadDocuments[at] = 0
      columns.totalTermFrequency[at] = term.occurrences
      columns.surfaceOccurrences[at] = term.surfaces
      columns.revision[at] = term.revision
      columns.flags[at] = term.flags
      const end = term.rowStart + term.length
      postings.docIds.set(this.docs.subarray(term.rowStart, end), term.rowStart)
      postings.frequencies.set(this.frequencies.subarray(term.rowStart, end), term.rowStart)
      postings.fieldIndices.set(this.fields.subarray(term.rowStart, end), term.rowStart)
      postings.positionStarts?.set(this.starts.subarray(term.rowStart, end), term.rowStart)
    }
    columns.flags.fill(0, this.terms.length, this.mapping.length)
    terms.header[0] = terms.header[1] = this.terms.length
    terms.header[4] = this.unitCount
    terms.header[3]++
    postings.allocation[0] = this.rowCount
    postings.allocation[1] = 0
    postings.freeHeads.fill(0xffffffff)
    if (positions !== null) {
      positions.values.set(this.positions.subarray(0, this.positionCount))
      positions.allocation[0] = this.positionCount
      positions.allocation[1] = 0
    }
    this.surfaces?.publish()
    this.spellings?.publish()
    this.publishRuns?.()
  }

  private publishTerm(table: NativeTermTable, term: VacuumTerm, ordinal: number): void {
    const mask = table.slots.length - 1
    let slot = stringHash(term.text) & mask
    while (table.slots[slot] !== 0) slot = (slot + 1) & mask
    table.slots[slot] = ordinal + 1
    table.termOffset[ordinal] = term.textStart
    table.termLength[ordinal] = term.text.length
    if (term.text.length > 0) {
      const first = term.text.charCodeAt(0)
      table.firstUnitNext[ordinal] = table.firstUnitHead[first]
      table.firstUnitHead[first] = ordinal + 1
    } else table.firstUnitNext[ordinal] = 0
  }
}
