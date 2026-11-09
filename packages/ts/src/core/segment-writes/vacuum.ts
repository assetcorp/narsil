import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'
import { TERM_VACUUM_MIN_DEAD_TERMS } from '../inverted-index/constants'
import { prepareSpellingVacuum } from '../partition/partial-words/registry'
import { storedText } from '../stored-values/text'
import { sparseStrings } from './maintenance'
import { NO_TERM, PostingRepack } from './repack'
import { requireSegment } from './status'
import { findString, stringHash } from './strings'
import { StringVacuum } from './vacuum-strings'

interface VacuumTerm {
  text: string
  textStart: number
  source: number
  frequency: number
  revision: number
  occurrences: number
  surfaces: number
}

function needed(segment: NativeGrowingSegment): boolean {
  const count = segment.terms.header[0]
  const live = segment.terms.header[1]
  if (count - live >= TERM_VACUUM_MIN_DEAD_TERMS && count - live > live) return true
  if (sparseStrings(segment.surfaces) || sparseStrings(segment.spellings)) return true
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
  private readonly units: Uint16Array
  private readonly rows: PostingRepack
  private unitCount = 0
  private readonly surfaces: StringVacuum | null
  private readonly spellings: StringVacuum | null
  private readonly publishRuns: (() => void) | null

  constructor(private readonly segment: NativeGrowingSegment) {
    const count = segment.terms.header[0]
    this.mapping = new Uint32Array(count).fill(NO_TERM)
    this.units = new Uint16Array(segment.terms.header[4])
    for (let at = 0; at < count; at++) {
      if (
        (segment.columns.flags[at] & 1) === 0 ||
        segment.columns.docFrequency[at] === segment.columns.deadDocuments[at]
      )
        continue
      this.collectTerm(at)
    }
    this.rows = new PostingRepack(segment, true, this.mapping)
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

  private collectTerm(ordinal: number): void {
    const { terms, columns } = this.segment
    const start = terms.termOffset[ordinal]
    const length = terms.termLength[ordinal]
    requireSegment(
      start <= terms.header[4] && length <= terms.header[4] - start && length <= terms.header[4] - this.unitCount,
    )
    const text = storedText(terms.units, start, length)
    requireSegment(findString(terms, text) === ordinal)
    this.mapping[ordinal] = this.terms.length
    this.terms.push({
      text,
      textStart: this.unitCount,
      source: ordinal,
      frequency: columns.docFrequency[ordinal] - columns.deadDocuments[ordinal],
      revision: (columns.revision[ordinal] + 1) >>> 0,
      occurrences: columns.totalTermFrequency[ordinal],
      surfaces: columns.surfaceOccurrences[ordinal],
    })
    this.units.set(terms.units.subarray(start, start + length), this.unitCount)
    this.unitCount += length
  }

  publish(): void {
    const { terms, columns } = this.segment
    const rows = this.rows
    terms.slots.fill(0)
    terms.firstUnitHead.fill(0)
    terms.units.set(this.units.subarray(0, this.unitCount))
    for (let at = 0; at < this.terms.length; at++) {
      const term = this.terms[at]
      this.publishTerm(terms, term, at)
      columns.sliceStart[at] = rows.targetStarts[term.source]
      columns.sliceClass[at] = rows.targetClasses[term.source]
      columns.lengths[at] = rows.targetLengths[term.source]
      columns.docFrequency[at] = term.frequency
      columns.deadDocuments[at] = 0
      columns.totalTermFrequency[at] = term.occurrences
      columns.surfaceOccurrences[at] = term.surfaces
      columns.revision[at] = term.revision
      columns.flags[at] = rows.targetFlags[term.source]
    }
    columns.flags.fill(0, this.terms.length, this.mapping.length)
    terms.header[0] = terms.header[1] = this.terms.length
    terms.header[4] = this.unitCount
    terms.header[3]++
    rows.publishRows()
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
