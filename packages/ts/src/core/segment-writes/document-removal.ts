import { findString, StringPlan, stringHash } from '#platform/segment-removal-host'
import type { NativeGrowingSegment, NativeSurfaceTable } from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'
import type { PreparedSegmentField } from './prepared-tokens'
import type { RemovedTerms } from './removal'
import type { StringPlan as SurfacePlan } from './strings'

const PREPARED_ROW_WORDS = 3
const SURFACE_WORD = 1
const ABSENT_TEXT = 0xffffffff
const LAST_MARK = 0xffffffff
const ABSENT = -1

export class DocumentRemoval implements RemovedTerms {
  size = 0
  ordinals = new Uint32Array(0)
  hashes = new Uint32Array(0)
  readonly texts: string[] = []
  surfaces: SurfacePlan | null = null
  private termMarks = new Uint32Array(0)
  private termAt = new Int32Array(0)
  private surfaceMarks = new Uint32Array(0)
  private surfaceAt = new Int32Array(0)
  private mark = 0
  private surfacePlan: SurfacePlan | null = null

  collect(segment: NativeGrowingSegment, texts: readonly string[], fields: readonly PreparedSegmentField[]): void {
    this.reserve(texts.length)
    this.size = 0
    this.texts.length = 0
    const mark = this.takeMark()
    const table = segment.surfaces
    const surfaces = table === null ? null : this.surfacePlanFor(table.strings)
    this.surfaces = surfaces
    const termMarks = this.termMarks
    const termAt = this.termAt
    for (const { text } of fields) {
      const rows = text.rows
      const end = text.count * PREPARED_ROW_WORDS
      for (let row = 0; row < end; row += PREPARED_ROW_WORDS) {
        const termId = rows[row]
        if (termMarks[termId] !== mark) {
          termMarks[termId] = mark
          termAt[termId] = this.addTerm(segment.terms, texts[termId])
        }
        if (surfaces === null || table === null || termAt[termId] === ABSENT) continue
        const surfaceId = rows[row + SURFACE_WORD]
        if (surfaceId !== ABSENT_TEXT && surfaceId !== termId)
          this.countSurface(table, surfaces, texts, surfaceId, termId, mark)
      }
    }
  }

  private addTerm(terms: NativeTermTable, text: string): number {
    const hash = stringHash(text)
    const found = findString(terms, text, hash)
    if (found < 0) return ABSENT
    const at = this.size++
    this.ordinals[at] = found
    this.hashes[at] = hash
    this.texts.push(text)
    return at
  }

  private countSurface(
    table: NativeSurfaceTable,
    surfaces: SurfacePlan,
    texts: readonly string[],
    surfaceId: number,
    termId: number,
    mark: number,
  ): void {
    const surface = texts[surfaceId]
    if (surface === '' || surface === texts[termId]) return
    if (this.surfaceMarks[surfaceId] !== mark) {
      this.surfaceMarks[surfaceId] = mark
      this.surfaceAt[surfaceId] = surfaces.prepareExisting(surface, false)
    }
    const at = this.surfaceAt[surfaceId]
    if (at < 0) return
    if (surfaces.counts[at] === 0) {
      surfaces.tokens[at] = table.token[surfaces.ordinals[at]]
      surfaces.points[at] = 0
    }
    surfaces.counts[at]++
  }

  private surfacePlanFor(strings: NativeTermTable): SurfacePlan {
    const plan = this.surfacePlan === null ? new StringPlan(strings) : this.surfacePlan.reset(strings)
    this.surfacePlan = plan
    return plan
  }

  private takeMark(): number {
    if (this.mark === LAST_MARK) {
      this.termMarks.fill(0)
      this.surfaceMarks.fill(0)
      this.mark = 0
    }
    return ++this.mark
  }

  private reserve(texts: number): void {
    if (texts <= this.termMarks.length) return
    const capacity = Math.max(texts, this.termMarks.length * 2)
    this.ordinals = new Uint32Array(capacity)
    this.hashes = new Uint32Array(capacity)
    this.termMarks = new Uint32Array(capacity)
    this.termAt = new Int32Array(capacity)
    this.surfaceMarks = new Uint32Array(capacity)
    this.surfaceAt = new Int32Array(capacity)
  }
}
