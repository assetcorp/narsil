import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import { PoolPlan, releaseSlice, type Slice } from './pools'
import { requireRoom, requireSegment } from './status'
import type { TokenPlan } from './tokens'

interface PostingChange {
  index: number
  ordinal: number
  oldLength: number
  kept: number
  frequency: number
  last: number
  addedRows: number
  flags: number
  isNew: boolean
  addedFrequency: number
  firstToken: number
  tokenEnd: number
  source: Slice
  target: Slice
}

export function rowRemoved(segment: NativeGrowingSegment, ordinal: number): boolean {
  return ordinal >= segment.ordinalCapacity || (segment.retired[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0
}

export class PostingPlan {
  readonly changes: PostingChange[] = []
  readonly pool: PoolPlan
  readonly purging: boolean
  private positionEnd: number
  private freedPositions = 0

  constructor(
    readonly segment: NativeGrowingSegment,
    readonly ordinal: number,
    readonly tokens: TokenPlan,
    private readonly compact = false,
  ) {
    this.purging = compact || rowRemoved(segment, ordinal)
    const positions = segment.positions
    this.positionEnd = positions?.allocation[0] ?? 0
    if (positions !== null)
      requireSegment(
        this.positionEnd > 0 &&
          this.positionEnd <= positions.values.length &&
          positions.allocation[1] < this.positionEnd,
      )
    this.pool = new PoolPlan({ ...segment.postings, values: segment.postings.docIds })
    const purged = new Map<number, PostingChange>()
    if (this.purging) {
      for (let token = 0; token < segment.terms.header[0]; token++) {
        if ((segment.columns.flags[token] & 1) === 0 || segment.columns.deadDocuments[token] === 0) continue
        purged.set(token, this.prepare(token, false))
      }
    }
    for (const entry of tokens.terms.entries) {
      const change = purged.get(entry.ordinal) ?? this.prepare(entry.ordinal, entry.added)
      entry.token = change.index
    }
    this.prepareRows()
    if (positions !== null) requireSegment(this.freedPositions <= positions.allocation[0] - positions.allocation[1])
    for (const change of this.changes) {
      requireRoom(change.addedRows <= 0xffffffff - change.kept)
      const length = change.kept + change.addedRows
      if (length > change.source.length) change.target = this.pool.allocate(length)
      requireSegment(change.addedRows === 0 || change.frequency < 0xffffffff)
    }
    this.pool.check()
  }

  publish(): void {
    const segment = this.segment
    this.pool.publish()
    let positionEnd = segment.positions?.allocation[0] ?? 0
    for (const change of this.changes) {
      if (this.purging || change.source.start !== change.target.start) this.copyKept(change)
      if (
        !this.purging &&
        change.source.start === change.target.start &&
        segment.positions !== null &&
        (change.flags & 4) === 0 &&
        change.kept > 0
      )
        segment.postings.positionStarts?.fill(0, change.target.start, change.target.start + change.kept)
      positionEnd = this.appendRows(change, positionEnd)
      this.publishColumns(change)
    }
    for (const change of this.changes) {
      if (change.source.sliceClass !== 255 && change.source.start !== change.target.start)
        releaseSlice(this.pool.pool, change.source)
    }
    if (this.purging && !this.compact) segment.retired.fill(0)
    if (segment.positions !== null) {
      segment.positions.allocation[0] = positionEnd
      segment.positions.allocation[1] += this.freedPositions
    }
  }

  private prepare(ordinal: number, isNew: boolean): PostingChange {
    const source = { start: 0, length: 0, sliceClass: 255 }
    const change: PostingChange = {
      index: this.changes.length,
      ordinal,
      isNew,
      source,
      target: source,
      oldLength: 0,
      kept: 0,
      frequency: 0,
      last: 0,
      addedRows: 0,
      flags: 3,
      addedFrequency: 0,
      firstToken: 0,
      tokenEnd: 0,
    }
    this.changes.push(change)
    if (isNew) return change
    const columns = this.segment.columns
    const postings = this.segment.postings
    const sliceClass = columns.sliceClass[ordinal]
    requireSegment(
      columns.docFrequency[ordinal] >= columns.deadDocuments[ordinal] &&
        columns.docFrequency[ordinal] <= columns.lengths[ordinal] &&
        Number.isFinite(columns.totalTermFrequency[ordinal]) &&
        columns.totalTermFrequency[ordinal] >= 0,
    )
    const start = columns.sliceStart[ordinal]
    const end = postings.allocation[0]
    if (
      sliceClass === 255 &&
      columns.lengths[ordinal] === 0 &&
      columns.docFrequency[ordinal] === 0 &&
      columns.deadDocuments[ordinal] === 0
    ) {
      change.isNew = true
      return change
    }
    requireSegment(sliceClass < postings.sliceCapacities.length && start <= end)
    const size = postings.sliceCapacities[sliceClass]
    requireSegment(size <= end - start && columns.lengths[ordinal] <= size)
    change.source = { start, length: size, sliceClass }
    change.target = change.source
    change.oldLength = columns.lengths[ordinal]
    change.kept = change.oldLength
    change.flags = columns.flags[ordinal]
    change.frequency = columns.docFrequency[ordinal]
    change.last = change.oldLength === 0 ? 0 : postings.docIds[start + change.oldLength - 1]
    if (!this.purging) return change
    change.kept = 0
    change.flags |= 2
    change.frequency -= columns.deadDocuments[ordinal]
    for (let at = start; at < start + change.oldLength; at++) {
      const doc = postings.docIds[at]
      if (rowRemoved(this.segment, doc)) {
        this.releasePositions(change, at)
        continue
      }
      if (change.kept > 0 && doc < change.last) change.flags &= ~2
      change.last = doc
      change.kept++
    }
    return change
  }

  private releasePositions(change: PostingChange, at: number): void {
    const positions = this.segment.positions
    const starts = this.segment.postings.positionStarts
    if (positions === null || starts === null || (change.flags & 4) === 0) return
    const position = starts[at]
    if (position === 0) return
    requireSegment(position < this.positionEnd)
    const count = positions.values[position]
    requireSegment(count < this.positionEnd - position)
    requireSegment(count + 1 <= 0xffffffff - this.freedPositions)
    this.freedPositions += count + 1
  }

  private prepareRows(): void {
    const tokens = this.tokens.tokens
    for (let start = 0; start < tokens.length; ) {
      const first = tokens[start]
      let end = start + 1
      while (end < tokens.length && tokens[end].term === first.term && tokens[end].field === first.field) end++
      const count = end - start
      const change = this.changes[this.tokens.terms.entries[first.term].token]
      if (change.addedRows === 0) change.firstToken = start
      change.tokenEnd = end
      change.addedRows++
      change.addedFrequency += Math.min(count, 65535)
      if (this.segment.positions !== null) {
        requireRoom(count < 0xffffffff && count + 1 <= this.segment.positions.values.length - this.positionEnd)
        this.positionEnd += count + 1
      }
      start = end
    }
  }

  private copyKept(change: PostingChange): void {
    const pool = this.segment.postings
    let kept = 0
    for (let at = change.source.start; at < change.source.start + change.oldLength; at++) {
      const doc = pool.docIds[at]
      if (this.purging && rowRemoved(this.segment, doc)) continue
      const target = change.target.start + kept++
      pool.docIds[target] = doc
      pool.frequencies[target] = pool.frequencies[at]
      pool.fieldIndices[target] = pool.fieldIndices[at]
      if (pool.positionStarts !== null)
        pool.positionStarts[target] = (change.flags & 4) === 0 ? 0 : pool.positionStarts[at]
    }
  }

  private appendRows(change: PostingChange, positionEnd: number): number {
    const pool = this.segment.postings
    const tokens = this.tokens.tokens
    const positions = this.segment.positions
    let output = change.target.start + change.kept
    for (let start = change.firstToken; start < change.tokenEnd; ) {
      const first = tokens[start]
      let end = start + 1
      while (end < change.tokenEnd && tokens[end].field === first.field) end++
      pool.docIds[output] = this.ordinal
      pool.frequencies[output] = Math.min(end - start, 65535)
      pool.fieldIndices[output] = first.field
      if (positions !== null && pool.positionStarts !== null) {
        pool.positionStarts[output] = positionEnd
        positions.values[positionEnd++] = end - start
        for (let at = start; at < end; at++) positions.values[positionEnd++] = tokens[at].position
      } else if (pool.positionStarts !== null) pool.positionStarts[output] = 0
      output++
      start = end
    }
    return positionEnd
  }

  private publishColumns(change: PostingChange): void {
    const columns = this.segment.columns
    const ordinal = change.ordinal
    let flags = change.flags
    if (change.kept > 0 && change.addedRows > 0 && this.ordinal < change.last) flags &= ~2
    if (change.addedRows > 0 && this.segment.positions !== null) flags |= 4
    columns.sliceStart[ordinal] = change.target.start
    columns.sliceClass[ordinal] = change.target.sliceClass
    columns.lengths[ordinal] = change.kept + change.addedRows
    columns.docFrequency[ordinal] = change.frequency + Number(change.addedRows > 0)
    if (this.purging || change.isNew) columns.deadDocuments[ordinal] = 0
    columns.totalTermFrequency[ordinal] =
      (change.isNew ? 0 : columns.totalTermFrequency[ordinal]) + change.addedFrequency
    if (change.isNew) columns.surfaceOccurrences[ordinal] = 0
    columns.revision[ordinal] = change.isNew ? 0 : columns.revision[ordinal] + 1
    columns.flags[ordinal] = flags
  }
}
