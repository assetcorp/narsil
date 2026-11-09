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
const LAST_MARK = 0xffffffff

export const DOCUMENT_INSERT_DECLINED = -1

class DocumentInsert {
  private readonly pool = new PoolPlan()
  private readonly surfaceOfText = new StampedMemo()
  private termPlan: StringPlan | null = null
  private surfacePlan: StringPlan | null = null
  private surfaces: StringPlan | null = null
  private mark = 0
  private termCount = 0
  private terms = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private documentMarks = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private fieldMarks = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private ordinals = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private fresh = new Uint8Array(WRITE_PLAN_START_CAPACITY)
  private postingsAdded = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private lastPositions = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private firstRecords = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private positionCursors = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private targetStarts = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private targetClasses = new Uint8Array(WRITE_PLAN_START_CAPACITY)
  private recordSizes = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private records = 0

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
    this.pool.publish()
    for (let at = 0; at < this.termCount; at++) this.openPostings(segment, this.terms[at], document)
    this.appendPostings(segment, document, fields)
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
    this.claim(texts.length, fields)
    this.surfaceOfText.claim(this, texts.length)
    this.termCount = 0
    const documentMark = this.takeMarks(fields.length + 1)
    const documentMarks = this.documentMarks
    const fieldMarks = this.fieldMarks
    const lastPositions = this.lastPositions
    const firstRecords = this.firstRecords
    const sizes = this.recordSizes
    let fieldMark = documentMark
    let record = 0
    for (const { text } of fields) {
      fieldMark++
      const rows = text.rows
      const end = text.count * PREPARED_ROW_WORDS
      for (let row = 0; row < end; row += PREPARED_ROW_WORDS) {
        const termId = rows[row]
        if (documentMarks[termId] !== documentMark) this.addTerm(segment, terms, texts[termId], termId, documentMark)
        const surfaceId = rows[row + 1]
        if (surfaceId !== ABSENT_TEXT && surfaceId !== termId) this.countSurface(segment, texts, surfaceId, termId)
        const position = rows[row + 2]
        sizes[record] = 0
        if (fieldMarks[termId] !== fieldMark) {
          fieldMarks[termId] = fieldMark
          firstRecords[termId] = record
          this.postingsAdded[termId]++
        } else if (lastPositions[termId] > position) return false
        lastPositions[termId] = position
        sizes[firstRecords[termId]]++
        record++
      }
    }
    return true
  }

  private addTerm(
    segment: NativeGrowingSegment,
    terms: StringPlan,
    text: string,
    termId: number,
    documentMark: number,
  ): void {
    this.documentMarks[termId] = documentMark
    this.terms[this.termCount++] = termId
    this.postingsAdded[termId] = 0
    const hash = stringHash(text)
    const found = findString(segment.terms, text, hash)
    if (found < 0) {
      const at = terms.prepareAbsent(text, hash)
      this.ordinals[termId] = terms.ordinals[at]
      this.fresh[termId] = 1
      return
    }
    this.ordinals[termId] = found
    this.fresh[termId] = this.holdsPostings(segment, found) ? 0 : 1
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
      plan.tokens[at] = added ? this.ordinals[termId] : table.token[plan.ordinals[at]]
      plan.points[at] = 0
    }
    addCount(plan, at, added ? 0 : table.count[plan.ordinals[at]], 1)
  }

  private allocate(segment: NativeGrowingSegment): void {
    const positions = segment.positions
    if (positions !== null) {
      const positionEnd = positions.allocation[0]
      requireSegment(positionEnd > 0 && positionEnd <= positions.values.length && positions.allocation[1] < positionEnd)
      let positionsNeeded = this.records
      for (let at = 0; at < this.termCount; at++) positionsNeeded += this.postingsAdded[this.terms[at]]
      requireRoom(positionsNeeded <= positions.values.length - positionEnd)
    }
    const postings = segment.postings
    const pool = this.pool.begin(postings, postings.docIds)
    const columns = segment.columns
    const capacities = postings.sliceCapacities
    for (let at = 0; at < this.termCount; at++) {
      const termId = this.terms[at]
      const ordinal = this.ordinals[termId]
      const fresh = this.fresh[termId] === 1
      const sourceClass = fresh ? NO_SLICE_CLASS : columns.sliceClass[ordinal]
      const kept = fresh ? 0 : columns.lengths[ordinal]
      const added = this.postingsAdded[termId]
      requireRoom(added <= MAX_POSTING_COUNT - kept)
      requireSegment(fresh || columns.docFrequency[ordinal] < MAX_POSTING_COUNT)
      if (kept + added > (fresh ? 0 : capacities[sourceClass])) {
        this.targetStarts[termId] = pool.allocateStart(kept + added, sourceClass)
        this.targetClasses[termId] = pool.allocatedClass
      } else {
        this.targetStarts[termId] = columns.sliceStart[ordinal]
        this.targetClasses[termId] = sourceClass
      }
    }
    pool.check()
  }

  private openPostings(segment: NativeGrowingSegment, termId: number, document: number): void {
    const postings = segment.postings
    const columns = segment.columns
    const starts = postings.positionStarts
    const docIds = postings.docIds
    const ordinal = this.ordinals[termId]
    const fresh = this.fresh[termId] === 1
    const target = this.targetStarts[termId]
    const source = fresh ? 0 : columns.sliceStart[ordinal]
    const sourceClass = fresh ? NO_SLICE_CLASS : columns.sliceClass[ordinal]
    const kept = fresh ? 0 : columns.lengths[ordinal]
    let flags = fresh ? NEW_TERM_FLAGS : columns.flags[ordinal]
    if (source !== target) {
      const keepsPositions = (flags & POSITIONS_FLAG) !== 0
      for (let at = 0; at < kept; at++) {
        docIds[target + at] = docIds[source + at]
        postings.frequencies[target + at] = postings.frequencies[source + at]
        postings.fieldIndices[target + at] = postings.fieldIndices[source + at]
        if (starts !== null) starts[target + at] = keepsPositions ? starts[source + at] : 0
      }
      if (sourceClass !== NO_SLICE_CLASS)
        releaseRange(postings, docIds, source, postings.sliceCapacities[sourceClass], sourceClass)
    } else if (segment.positions !== null && (flags & POSITIONS_FLAG) === 0 && kept > 0)
      starts?.fill(0, target, target + kept)
    if (kept > 0 && (flags & ORDERED_FLAG) !== 0 && document < docIds[target + kept - 1]) flags &= ~ORDERED_FLAG
    if (segment.positions !== null) flags |= POSITIONS_FLAG
    columns.sliceStart[ordinal] = target
    columns.sliceClass[ordinal] = this.targetClasses[termId]
    columns.lengths[ordinal] = kept
    columns.docFrequency[ordinal] = (fresh ? 0 : columns.docFrequency[ordinal]) + 1
    if (fresh) {
      columns.deadDocuments[ordinal] = 0
      columns.totalTermFrequency[ordinal] = 0
      columns.surfaceOccurrences[ordinal] = 0
    }
    columns.revision[ordinal] = fresh ? 0 : columns.revision[ordinal] + 1
    columns.flags[ordinal] = flags
  }

  private appendPostings(
    segment: NativeGrowingSegment,
    document: number,
    fields: readonly PreparedSegmentField[],
  ): void {
    const postings = segment.postings
    const columns = segment.columns
    const positions = segment.positions
    const starts = postings.positionStarts
    const values = positions === null || starts === null ? null : positions.values
    const ordinals = this.ordinals
    const cursors = this.positionCursors
    const sizes = this.recordSizes
    let positionEnd = positions?.allocation[0] ?? 0
    let record = 0
    for (const { field, text } of fields) {
      const rows = text.rows
      const end = text.count * PREPARED_ROW_WORDS
      for (let row = 0; row < end; row += PREPARED_ROW_WORDS) {
        const termId = rows[row]
        const size = sizes[record++]
        if (size > 0) {
          const ordinal = ordinals[termId]
          const output = columns.sliceStart[ordinal] + columns.lengths[ordinal]
          const stored = size < MAX_ROW_FREQUENCY ? size : MAX_ROW_FREQUENCY
          postings.docIds[output] = document
          postings.frequencies[output] = stored
          postings.fieldIndices[output] = field
          if (values !== null && starts !== null) {
            starts[output] = positionEnd
            values[positionEnd] = size
            cursors[termId] = positionEnd + 1
            positionEnd += size + 1
          } else if (starts !== null) starts[output] = 0
          columns.lengths[ordinal]++
          columns.totalTermFrequency[ordinal] += stored
        }
        if (values !== null) values[cursors[termId]++] = rows[row + 2]
      }
    }
    if (positions !== null && values !== null) positions.allocation[0] = positionEnd
  }

  private takeMarks(count: number): number {
    if (this.mark > LAST_MARK - count) {
      this.documentMarks.fill(0)
      this.fieldMarks.fill(0)
      this.mark = 0
    }
    const first = this.mark + 1
    this.mark += count
    return first
  }

  private claim(texts: number, fields: readonly PreparedSegmentField[]): void {
    let records = 0
    for (const { text } of fields) records += text.count
    this.records = records
    if (records > this.recordSizes.length)
      this.recordSizes = new Uint32Array(Math.max(records, this.recordSizes.length * 2))
    if (texts <= this.terms.length) return
    const capacity = Math.max(texts, this.terms.length * 2)
    this.terms = new Uint32Array(capacity)
    this.documentMarks = grownWords(this.documentMarks, capacity)
    this.fieldMarks = grownWords(this.fieldMarks, capacity)
    this.ordinals = new Uint32Array(capacity)
    this.fresh = grownBytes(this.fresh, capacity)
    this.postingsAdded = new Uint32Array(capacity)
    this.lastPositions = new Uint32Array(capacity)
    this.firstRecords = new Uint32Array(capacity)
    this.positionCursors = new Uint32Array(capacity)
    this.targetStarts = new Uint32Array(capacity)
    this.targetClasses = new Uint8Array(capacity)
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
