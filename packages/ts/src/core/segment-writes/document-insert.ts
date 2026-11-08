import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import { holdsUnpairedSurrogate } from '../ordering/code-points'
import { WRITE_PLAN_START_CAPACITY } from './constants'
import { grownBytes, grownWords, publishFieldLengths, publishSurfaceCounts, sharedTexts } from './document-publish'
import { PoolPlan, releaseRange } from './pools'
import { rowRemoved } from './postings'
import { PREPARED_ROW_WORDS, type PreparedSegmentField } from './prepared-tokens'
import { requireRoom, requireSegment } from './status'
import { StampedMemo } from './string-memo'
import { addCount, findString, StringPlan, stringHash } from './strings'

const NO_SLICE_CLASS = 255
const NEW_TERM_FLAGS = 3
const ORDERED_FLAG = 2
const POSITIONS_FLAG = 4
const MAX_ROW_FREQUENCY = 65535
const MAX_POSTING_COUNT = 0xffffffff
const ABSENT_TEXT = 0xffffffff
const NO_ROW = 0xffffffff

export const DOCUMENT_INSERT_DECLINED = -1

class DocumentInsert {
  private readonly pool = new PoolPlan()
  private readonly changeOfText = new StampedMemo()
  private readonly surfaceOfText = new StampedMemo()
  private termPlan: StringPlan | null = null
  private surfacePlan: StringPlan | null = null
  private surfaces: StringPlan | null = null
  private changeCount = 0
  private ordinals = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private fresh = new Uint8Array(WRITE_PLAN_START_CAPACITY)
  private heads = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private tails = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private addedRows = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private sourceStarts = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private sourceClasses = new Uint8Array(WRITE_PLAN_START_CAPACITY)
  private targetStarts = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private targetClasses = new Uint8Array(WRITE_PLAN_START_CAPACITY)
  private rowCount = 0
  private rowFields = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private rowSizes = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private rowLasts = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private rowNexts = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private rowCursors = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private tokenRows = new Uint32Array(WRITE_PLAN_START_CAPACITY)

  insert(segment: NativeGrowingSegment, document: number, fields: readonly PreparedSegmentField[]): number {
    const texts = sharedTexts(fields)
    if (texts === null || segment.spellings !== null || rowRemoved(segment, document)) return DOCUMENT_INSERT_DECLINED
    requireSegment(segment.totalDocuments[0] < segment.ordinalCapacity)
    for (const total of segment.totalFieldLengths) requireSegment(Number.isFinite(total) && total >= 0)
    for (const text of texts) requireSegment(!holdsUnpairedSurrogate(text))
    const terms = this.beginStrings(segment)
    if (!this.collect(segment, texts, fields, terms)) return DOCUMENT_INSERT_DECLINED
    terms.check()
    this.surfaces?.check()
    this.allocate(segment)
    terms.publish()
    this.publishPostings(segment, document)
    this.writePositions(segment, fields)
    publishSurfaceCounts(this.surfaces, segment)
    publishFieldLengths(segment, document, fields)
    return 0
  }

  private beginStrings(segment: NativeGrowingSegment): StringPlan {
    const terms = this.termPlan === null ? new StringPlan(segment.terms) : this.termPlan.reset(segment.terms)
    this.termPlan = terms
    this.surfaces = null
    if (segment.surfaces !== null) {
      const strings = segment.surfaces.strings
      this.surfacePlan = this.surfacePlan === null ? new StringPlan(strings) : this.surfacePlan.reset(strings)
      this.surfaces = this.surfacePlan
    }
    return terms
  }

  private collect(
    segment: NativeGrowingSegment,
    texts: readonly string[],
    fields: readonly PreparedSegmentField[],
    terms: StringPlan,
  ): boolean {
    this.changeOfText.claim(this, texts.length)
    this.surfaceOfText.claim(this, texts.length)
    this.changeCount = 0
    this.rowCount = 0
    let records = 0
    for (const { text } of fields) records += text.count
    if (records > this.tokenRows.length) this.tokenRows = new Uint32Array(Math.max(records, this.tokenRows.length * 2))
    const tokenRows = this.tokenRows
    let token = 0
    for (const { field, text } of fields) {
      const rows = text.rows
      const end = text.count * PREPARED_ROW_WORDS
      for (let row = 0; row < end; row += PREPARED_ROW_WORDS) {
        const termId = rows[row]
        let change = this.changeOfText.get(termId)
        if (change < 0) {
          change = this.addChange(segment, terms, texts[termId])
          this.changeOfText.set(termId, change)
        }
        const surfaceId = rows[row + 1]
        if (surfaceId !== ABSENT_TEXT && surfaceId !== termId)
          this.countSurface(segment, texts, surfaceId, termId, change)
        const position = rows[row + 2]
        const tail = this.tails[change]
        let target = tail
        if (tail === NO_ROW || this.rowFields[tail] !== field) target = this.addRow(change, field)
        else if (this.rowLasts[tail] > position) return false
        this.rowSizes[target]++
        this.rowLasts[target] = position
        tokenRows[token++] = target
      }
    }
    return true
  }

  private addChange(segment: NativeGrowingSegment, terms: StringPlan, text: string): number {
    const change = this.changeCount
    if (change === this.ordinals.length) this.growChanges()
    this.changeCount = change + 1
    this.tails[change] = NO_ROW
    const hash = stringHash(text)
    const found = findString(segment.terms, text, hash)
    if (found < 0) {
      const at = terms.prepareAbsent(text, hash)
      this.ordinals[change] = terms.ordinals[at]
      this.fresh[change] = 1
      return change
    }
    this.ordinals[change] = found
    this.fresh[change] = this.holdsPostings(segment, found) ? 0 : 1
    return change
  }

  private holdsPostings(segment: NativeGrowingSegment, ordinal: number): boolean {
    const columns = segment.columns
    const postings = segment.postings
    const sliceClass = columns.sliceClass[ordinal]
    const length = columns.lengths[ordinal]
    const documents = columns.docFrequency[ordinal]
    const dead = columns.deadDocuments[ordinal]
    const total = columns.totalTermFrequency[ordinal]
    requireSegment(documents >= dead && documents <= length && Number.isFinite(total) && total >= 0)
    if (sliceClass === NO_SLICE_CLASS && length === 0 && documents === 0 && dead === 0) return false
    const start = columns.sliceStart[ordinal]
    const end = postings.allocation[0]
    requireSegment(sliceClass < postings.sliceCapacities.length && start <= end)
    const size = postings.sliceCapacities[sliceClass]
    requireSegment(size <= end - start && length <= size)
    return true
  }

  private countSurface(
    segment: NativeGrowingSegment,
    texts: readonly string[],
    surfaceId: number,
    termId: number,
    change: number,
  ): void {
    const surface = texts[surfaceId]
    if (surface === '' || surface === texts[termId]) return
    const plan = this.surfaces
    const table = segment.surfaces
    if (plan === null || table === null) {
      requireRoom(false)
      return
    }
    let at = this.surfaceOfText.get(surfaceId)
    if (at < 0) {
      at = plan.prepare(surface, false)
      this.surfaceOfText.set(surfaceId, at)
    }
    const added = plan.added[at] === 1
    if (plan.counts[at] === 0) {
      plan.tokens[at] = added ? this.ordinals[change] : table.token[plan.ordinals[at]]
      plan.points[at] = 0
    }
    addCount(plan, at, added ? 0 : table.count[plan.ordinals[at]], 1)
  }

  private addRow(change: number, field: number): number {
    const row = this.rowCount
    if (row === this.rowFields.length) this.growRows()
    this.rowCount = row + 1
    this.rowFields[row] = field
    this.rowSizes[row] = 0
    this.rowNexts[row] = NO_ROW
    const tail = this.tails[change]
    if (tail === NO_ROW) this.heads[change] = row
    else this.rowNexts[tail] = row
    this.tails[change] = row
    return row
  }

  private allocate(segment: NativeGrowingSegment): void {
    const positions = segment.positions
    const positionEnd = positions?.allocation[0] ?? 0
    if (positions !== null)
      requireSegment(positionEnd > 0 && positionEnd <= positions.values.length && positions.allocation[1] < positionEnd)
    const postings = segment.postings
    const pool = this.pool.begin(postings, postings.docIds)
    const positionRoom = positions === null ? 0 : positions.values.length - positionEnd
    let positionsNeeded = 0
    for (let change = 0; change < this.changeCount; change++) {
      let added = 0
      for (let row = this.heads[change]; row !== NO_ROW; row = this.rowNexts[row]) {
        added++
        if (positions === null) continue
        const size = this.rowSizes[row]
        requireRoom(size < MAX_POSTING_COUNT && size + 1 <= positionRoom - positionsNeeded)
        positionsNeeded += size + 1
      }
      this.addedRows[change] = added
    }
    const columns = segment.columns
    const capacities = postings.sliceCapacities
    for (let change = 0; change < this.changeCount; change++) {
      const ordinal = this.ordinals[change]
      const fresh = this.fresh[change] === 1
      const sourceClass = fresh ? NO_SLICE_CLASS : columns.sliceClass[ordinal]
      const sourceStart = fresh ? 0 : columns.sliceStart[ordinal]
      const kept = fresh ? 0 : columns.lengths[ordinal]
      const added = this.addedRows[change]
      requireRoom(added <= MAX_POSTING_COUNT - kept)
      let target = sourceStart
      let targetClass = sourceClass
      if (kept + added > (fresh ? 0 : capacities[sourceClass])) {
        target = pool.allocateStart(kept + added, sourceClass)
        targetClass = pool.allocatedClass
      }
      requireSegment(added === 0 || fresh || columns.docFrequency[ordinal] < MAX_POSTING_COUNT)
      this.sourceStarts[change] = sourceStart
      this.sourceClasses[change] = sourceClass
      this.targetStarts[change] = target
      this.targetClasses[change] = targetClass
    }
    pool.check()
  }

  private publishPostings(segment: NativeGrowingSegment, document: number): void {
    this.pool.publish()
    const postings = segment.postings
    const columns = segment.columns
    const positions = segment.positions
    const starts = postings.positionStarts
    const docIds = postings.docIds
    let positionEnd = positions?.allocation[0] ?? 0
    for (let change = 0; change < this.changeCount; change++) {
      const ordinal = this.ordinals[change]
      const fresh = this.fresh[change] === 1
      const target = this.targetStarts[change]
      const kept = fresh ? 0 : columns.lengths[ordinal]
      let flags = fresh ? NEW_TERM_FLAGS : columns.flags[ordinal]
      if (this.sourceStarts[change] !== target) this.copyKept(segment, change, kept, flags)
      else if (positions !== null && (flags & POSITIONS_FLAG) === 0 && kept > 0) starts?.fill(0, target, target + kept)
      let output = target + kept
      let frequency = 0
      for (let row = this.heads[change]; row !== NO_ROW; row = this.rowNexts[row]) {
        const size = this.rowSizes[row]
        const stored = size < MAX_ROW_FREQUENCY ? size : MAX_ROW_FREQUENCY
        docIds[output] = document
        postings.frequencies[output] = stored
        postings.fieldIndices[output] = this.rowFields[row]
        if (positions !== null && starts !== null) {
          starts[output] = positionEnd
          positions.values[positionEnd] = size
          this.rowCursors[row] = positionEnd + 1
          positionEnd += size + 1
        } else if (starts !== null) starts[output] = 0
        frequency += stored
        output++
      }
      const added = this.addedRows[change]
      if (kept > 0 && added > 0 && (flags & ORDERED_FLAG) !== 0 && document < docIds[target + kept - 1])
        flags &= ~ORDERED_FLAG
      if (added > 0 && positions !== null) flags |= POSITIONS_FLAG
      columns.sliceStart[ordinal] = target
      columns.sliceClass[ordinal] = this.targetClasses[change]
      columns.lengths[ordinal] = kept + added
      columns.docFrequency[ordinal] = (fresh ? 0 : columns.docFrequency[ordinal]) + Number(added > 0)
      if (fresh) columns.deadDocuments[ordinal] = 0
      columns.totalTermFrequency[ordinal] = (fresh ? 0 : columns.totalTermFrequency[ordinal]) + frequency
      if (fresh) columns.surfaceOccurrences[ordinal] = 0
      columns.revision[ordinal] = fresh ? 0 : columns.revision[ordinal] + 1
      columns.flags[ordinal] = flags
    }
    for (let change = 0; change < this.changeCount; change++) {
      const sourceClass = this.sourceClasses[change]
      const source = this.sourceStarts[change]
      if (sourceClass !== NO_SLICE_CLASS && source !== this.targetStarts[change])
        releaseRange(postings, docIds, source, postings.sliceCapacities[sourceClass], sourceClass)
    }
    if (positions !== null) positions.allocation[0] = positionEnd
  }

  private copyKept(segment: NativeGrowingSegment, change: number, kept: number, flags: number): void {
    const pool = segment.postings
    const source = this.sourceStarts[change]
    const target = this.targetStarts[change]
    const starts = pool.positionStarts
    const keepsPositions = (flags & POSITIONS_FLAG) !== 0
    for (let at = 0; at < kept; at++) {
      pool.docIds[target + at] = pool.docIds[source + at]
      pool.frequencies[target + at] = pool.frequencies[source + at]
      pool.fieldIndices[target + at] = pool.fieldIndices[source + at]
      if (starts !== null) starts[target + at] = keepsPositions ? starts[source + at] : 0
    }
  }

  private writePositions(segment: NativeGrowingSegment, fields: readonly PreparedSegmentField[]): void {
    const positions = segment.positions
    if (positions === null || segment.postings.positionStarts === null) return
    const values = positions.values
    const cursors = this.rowCursors
    const tokenRows = this.tokenRows
    let token = 0
    for (const { text } of fields) {
      const rows = text.rows
      const end = text.count * PREPARED_ROW_WORDS
      for (let row = 2; row < end; row += PREPARED_ROW_WORDS) values[cursors[tokenRows[token++]]++] = rows[row]
    }
  }

  private growChanges(): void {
    const capacity = this.ordinals.length * 2
    this.ordinals = grownWords(this.ordinals, capacity)
    this.fresh = grownBytes(this.fresh, capacity)
    this.heads = grownWords(this.heads, capacity)
    this.tails = grownWords(this.tails, capacity)
    this.addedRows = grownWords(this.addedRows, capacity)
    this.sourceStarts = grownWords(this.sourceStarts, capacity)
    this.sourceClasses = grownBytes(this.sourceClasses, capacity)
    this.targetStarts = grownWords(this.targetStarts, capacity)
    this.targetClasses = grownBytes(this.targetClasses, capacity)
  }

  private growRows(): void {
    const capacity = this.rowFields.length * 2
    this.rowFields = grownWords(this.rowFields, capacity)
    this.rowSizes = grownWords(this.rowSizes, capacity)
    this.rowLasts = grownWords(this.rowLasts, capacity)
    this.rowNexts = grownWords(this.rowNexts, capacity)
    this.rowCursors = grownWords(this.rowCursors, capacity)
  }
}

const documentInsert = new DocumentInsert()

export function insertPreparedDocument(
  segment: NativeGrowingSegment,
  document: number,
  fields: readonly PreparedSegmentField[],
): number {
  return documentInsert.insert(segment, document, fields)
}
