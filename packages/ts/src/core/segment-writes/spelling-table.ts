import type { NativeSpellingTable } from '../../vector/native/types/segments'
import { grownCapacity } from '../inverted-index/pools'
import type { TermColumns } from '../inverted-index/terms'
import type { PartialSpellings } from '../partition/partial-words/spellings'
import { reserveStrings } from './capacity'
import { SURFACE_TABLE_START_CAPACITY } from './constants'
import { RunTable } from './run-table'
import { collectRuns, RunPlan } from './runs'
import { SegmentRefusal } from './status'
import { StringPlan } from './strings'
import { SurfaceTable } from './surface-table'

export class SpellingTable extends SurfaceTable implements NativeSpellingTable {
  codePoints = new Uint32Array(SURFACE_TABLE_START_CAPACITY)
  readonly runs = new RunTable()

  load(source: PartialSpellings, terms: TermColumns): void {
    this.reserveWords(new Set(source.spellings))
    const plan = new StringPlan(this.strings)
    for (let at = 0; at < source.spellings.length; at++) {
      const token = terms.ids.get(source.tokens[at])
      if (token === undefined || terms.frequencyAt(token) === 0) continue
      const spelling = source.spellings[at]
      const entry = plan.prepare(spelling)
      if (plan.counts[entry] === 0) plan.tokens[entry] = token
      plan.counts[entry] += source.counts[at]
      let points = 0
      for (const _point of spelling) points++
      plan.points[entry] = points
      if (plan.counts[entry] > 0xffffffff) throw new SegmentRefusal(8)
    }
    plan.check()
    const runs = new RunPlan(this.runs, collectRuns(plan))
    plan.publish()
    for (let at = 0; at < plan.size; at++) {
      const ordinal = plan.ordinals[at]
      this.token[ordinal] = plan.tokens[at]
      this.count[ordinal] = plan.counts[at]
      this.codePoints[ordinal] = plan.points[at]
    }
    runs.publish()
  }

  reserveWords(words: ReadonlySet<string>): void {
    const spellings = new Set<string>()
    const plan = new StringPlan(this.strings)
    for (const word of words) {
      let points = 0
      for (const _point of word) points++
      if (points <= 3) continue
      spellings.add(word)
      const entry = plan.prepare(word)
      plan.points[entry] = points
    }
    reserveStrings(this, spellings)
    const members = collectRuns(plan)
    if (members.length === 0) return
    const count = this.runs.header[0] + members.length
    this.runs.reserve(count, this.runs.members.length)
    for (;;) {
      try {
        new RunPlan(this.runs, members)
        return
      } catch (error) {
        if (!(error instanceof SegmentRefusal) || error.status !== 3) throw error
        this.runs.reserve(count, grownCapacity(this.runs.members.length, this.runs.members.length + 1))
      }
    }
  }

  override reserve(entries: number, units: number): void {
    const prepared = this.prepareCapacity(entries, units)
    let points = this.codePoints
    if (prepared.capacity > points.length) {
      points = new Uint32Array(prepared.capacity)
      points.set(this.codePoints)
    }
    prepared.apply()
    this.codePoints = points
  }

  override byteLength(): number {
    return super.byteLength() + this.codePoints.byteLength + this.runs.byteLength()
  }
}
