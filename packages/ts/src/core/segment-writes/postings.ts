import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import { POSTING_LIST_COMPACTION_THRESHOLD } from '../constants'
import { WRITE_PLAN_START_CAPACITY } from './constants'
import { PoolPlan, releaseRange } from './pools'
import { requireRoom, requireSegment } from './status'
import { StampedMemo } from './string-memo'
import { TOKEN_REFERENCE_WORDS, type TokenPlan } from './tokens'

const NO_SLICE_CLASS = 255
const NEW_TERM_FLAGS = 3
const MAX_ROW_FREQUENCY = 65535
const MAX_POSTING_COUNT = 0xffffffff

export function rowRemoved(
  segment: Pick<NativeGrowingSegment, 'ordinalCapacity' | 'retired'>,
  ordinal: number,
): boolean {
  return ordinal >= segment.ordinalCapacity || (segment.retired[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0
}

function grownColumn<Column extends Uint8Array | Uint32Array | Float64Array>(held: Column, grown: Column): Column {
  grown.set(held)
  return grown
}

export class PostingPlan {
  segment: NativeGrowingSegment
  ordinal = 0
  tokens: TokenPlan
  purging = false
  size = 0
  ordinals = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private oldLengths = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private kept = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private frequencies = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private addedRows = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private flags = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private isNew = new Uint8Array(WRITE_PLAN_START_CAPACITY)
  private addedFrequencies = new Float64Array(WRITE_PLAN_START_CAPACITY)
  private firstTokens = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private tokenEnds = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private sourceStarts = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private sourceLengths = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private sourceClasses = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private targetStarts = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private targetClasses = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private readonly purged = new StampedMemo()
  private readonly pool = new PoolPlan()
  private compact = false
  private positionEnd = 0
  private freedPositions = 0

  constructor(segment: NativeGrowingSegment, tokens: TokenPlan) {
    this.segment = segment
    this.tokens = tokens
  }

  prepare(segment: NativeGrowingSegment, ordinal: number, tokens: TokenPlan, compact: boolean): this {
    this.segment = segment
    this.ordinal = ordinal
    this.tokens = tokens
    this.compact = compact
    this.size = 0
    this.freedPositions = 0
    this.purging = compact || rowRemoved(segment, ordinal)
    const positions = segment.positions
    this.positionEnd = positions?.allocation[0] ?? 0
    if (positions !== null)
      requireSegment(
        this.positionEnd > 0 &&
          this.positionEnd <= positions.values.length &&
          positions.allocation[1] < this.positionEnd,
      )
    this.pool.begin(segment.postings, segment.postings.docIds)
    const terms = tokens.terms
    if (this.purging) {
      this.purged.claim(this, segment.terms.header[0])
      const { flags, deadDocuments, docFrequency, lengths } = segment.columns
      for (let token = 0; token < segment.terms.header[0]; token++) {
        const dead = deadDocuments[token]
        if ((flags[token] & 1) === 0 || dead === 0) continue
        if (compact && dead < docFrequency[token] && dead / lengths[token] <= POSTING_LIST_COMPACTION_THRESHOLD)
          continue
        this.purged.set(token, this.prepareChange(token, false))
      }
      for (let at = 0; at < terms.size; at++) {
        const held = this.purged.get(terms.ordinals[at])
        terms.tokens[at] = held >= 0 ? held : this.prepareChange(terms.ordinals[at], terms.added[at] === 1)
      }
    } else {
      for (let at = 0; at < terms.size; at++)
        terms.tokens[at] = this.prepareChange(terms.ordinals[at], terms.added[at] === 1)
    }
    this.prepareRows()
    if (positions !== null) requireSegment(this.freedPositions <= positions.allocation[0] - positions.allocation[1])
    for (let at = 0; at < this.size; at++) {
      requireRoom(this.addedRows[at] <= MAX_POSTING_COUNT - this.kept[at])
      const length = this.kept[at] + this.addedRows[at]
      if (length > this.sourceLengths[at]) {
        this.targetStarts[at] = this.pool.allocateStart(length, this.sourceClasses[at])
        this.targetClasses[at] = this.pool.allocatedClass
      }
      requireSegment(this.addedRows[at] === 0 || this.frequencies[at] < MAX_POSTING_COUNT)
    }
    this.pool.check()
    return this
  }

  publish(): void {
    const segment = this.segment
    this.pool.publish()
    let positionEnd = segment.positions?.allocation[0] ?? 0
    for (let at = 0; at < this.size; at++) {
      const moved = this.sourceStarts[at] !== this.targetStarts[at]
      if (this.purging || moved) this.copyKept(at)
      if (!this.purging && !moved && segment.positions !== null && (this.flags[at] & 4) === 0 && this.kept[at] > 0)
        segment.postings.positionStarts?.fill(0, this.targetStarts[at], this.targetStarts[at] + this.kept[at])
      positionEnd = this.appendRows(at, positionEnd)
      this.publishColumns(at)
    }
    const postings = segment.postings
    for (let at = 0; at < this.size; at++) {
      if (this.sourceClasses[at] !== NO_SLICE_CLASS && this.sourceStarts[at] !== this.targetStarts[at])
        releaseRange(postings, postings.docIds, this.sourceStarts[at], this.sourceLengths[at], this.sourceClasses[at])
    }
    if (this.purging && !this.compact) segment.retired.fill(0)
    if (segment.positions !== null) {
      segment.positions.allocation[0] = positionEnd
      segment.positions.allocation[1] += this.freedPositions
    }
  }

  private prepareChange(ordinal: number, isNew: boolean): number {
    const at = this.size
    if (at === this.ordinals.length) this.grow()
    this.size = at + 1
    this.ordinals[at] = ordinal
    this.addedRows[at] = 0
    this.addedFrequencies[at] = 0
    this.firstTokens[at] = 0
    this.tokenEnds[at] = 0
    if (isNew || this.existingChange(at, ordinal)) this.newChange(at)
    return at
  }

  private newChange(at: number): void {
    this.isNew[at] = 1
    this.sourceStarts[at] = 0
    this.sourceLengths[at] = 0
    this.sourceClasses[at] = NO_SLICE_CLASS
    this.targetStarts[at] = 0
    this.targetClasses[at] = NO_SLICE_CLASS
    this.oldLengths[at] = 0
    this.kept[at] = 0
    this.frequencies[at] = 0
    this.flags[at] = NEW_TERM_FLAGS
  }

  private existingChange(at: number, ordinal: number): boolean {
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
      sliceClass === NO_SLICE_CLASS &&
      columns.lengths[ordinal] === 0 &&
      columns.docFrequency[ordinal] === 0 &&
      columns.deadDocuments[ordinal] === 0
    )
      return true
    requireSegment(sliceClass < postings.sliceCapacities.length && start <= end)
    const size = postings.sliceCapacities[sliceClass]
    requireSegment(size <= end - start && columns.lengths[ordinal] <= size)
    this.isNew[at] = 0
    this.sourceStarts[at] = start
    this.sourceLengths[at] = size
    this.sourceClasses[at] = sliceClass
    this.targetStarts[at] = start
    this.targetClasses[at] = sliceClass
    const oldLength = columns.lengths[ordinal]
    this.oldLengths[at] = oldLength
    this.flags[at] = columns.flags[ordinal]
    this.frequencies[at] = columns.docFrequency[ordinal]
    if (!this.purging) {
      this.kept[at] = oldLength
      return false
    }
    let last = 0
    let kept = 0
    let flags = this.flags[at] | 2
    this.frequencies[at] -= columns.deadDocuments[ordinal]
    for (let row = start; row < start + oldLength; row++) {
      const doc = postings.docIds[row]
      if (rowRemoved(this.segment, doc)) {
        this.releasePositions(flags, row)
        continue
      }
      if (kept > 0 && doc < last) flags &= ~2
      last = doc
      kept++
    }
    this.kept[at] = kept
    this.flags[at] = flags
    return false
  }

  private releasePositions(flags: number, row: number): void {
    const positions = this.segment.positions
    const starts = this.segment.postings.positionStarts
    if (positions === null || starts === null || (flags & 4) === 0) return
    const position = starts[row]
    if (position === 0) return
    requireSegment(position < this.positionEnd)
    const count = positions.values[position]
    requireSegment(count < this.positionEnd - position)
    requireSegment(count + 1 <= MAX_POSTING_COUNT - this.freedPositions)
    this.freedPositions += count + 1
  }

  private prepareRows(): void {
    const tokens = this.tokens.tokens
    const total = this.tokens.count
    const changes = this.tokens.terms.tokens
    const positions = this.segment.positions
    for (let start = 0; start < total; ) {
      const term = tokens[start * TOKEN_REFERENCE_WORDS]
      const field = tokens[start * TOKEN_REFERENCE_WORDS + 1]
      let end = start + 1
      while (
        end < total &&
        tokens[end * TOKEN_REFERENCE_WORDS] === term &&
        tokens[end * TOKEN_REFERENCE_WORDS + 1] === field
      )
        end++
      const count = end - start
      const at = changes[term]
      if (this.addedRows[at] === 0) this.firstTokens[at] = start
      this.tokenEnds[at] = end
      this.addedRows[at]++
      this.addedFrequencies[at] += Math.min(count, MAX_ROW_FREQUENCY)
      if (positions !== null) {
        requireRoom(count < MAX_POSTING_COUNT && count + 1 <= positions.values.length - this.positionEnd)
        this.positionEnd += count + 1
      }
      start = end
    }
  }

  private copyKept(at: number): void {
    const pool = this.segment.postings
    const source = this.sourceStarts[at]
    const target = this.targetStarts[at]
    const keepsPositions = (this.flags[at] & 4) !== 0
    let kept = 0
    for (let row = source; row < source + this.oldLengths[at]; row++) {
      const doc = pool.docIds[row]
      if (this.purging && rowRemoved(this.segment, doc)) continue
      const output = target + kept++
      pool.docIds[output] = doc
      pool.frequencies[output] = pool.frequencies[row]
      pool.fieldIndices[output] = pool.fieldIndices[row]
      if (pool.positionStarts !== null) pool.positionStarts[output] = keepsPositions ? pool.positionStarts[row] : 0
    }
  }

  private appendRows(at: number, positionEnd: number): number {
    const pool = this.segment.postings
    const tokens = this.tokens.tokens
    const positions = this.segment.positions
    const tokenEnd = this.tokenEnds[at]
    let output = this.targetStarts[at] + this.kept[at]
    for (let start = this.firstTokens[at]; start < tokenEnd; ) {
      const field = tokens[start * TOKEN_REFERENCE_WORDS + 1]
      let end = start + 1
      while (end < tokenEnd && tokens[end * TOKEN_REFERENCE_WORDS + 1] === field) end++
      pool.docIds[output] = this.ordinal
      pool.frequencies[output] = Math.min(end - start, MAX_ROW_FREQUENCY)
      pool.fieldIndices[output] = field
      if (positions !== null && pool.positionStarts !== null) {
        pool.positionStarts[output] = positionEnd
        positions.values[positionEnd++] = end - start
        for (let token = start; token < end; token++)
          positions.values[positionEnd++] = tokens[token * TOKEN_REFERENCE_WORDS + 2]
      } else if (pool.positionStarts !== null) pool.positionStarts[output] = 0
      output++
      start = end
    }
    return positionEnd
  }

  private publishColumns(at: number): void {
    const columns = this.segment.columns
    const ordinal = this.ordinals[at]
    const isNew = this.isNew[at] === 1
    const addedRows = this.addedRows[at]
    let flags = this.flags[at]
    const kept = this.kept[at]
    if (
      kept > 0 &&
      addedRows > 0 &&
      (flags & 2) !== 0 &&
      this.ordinal < this.segment.postings.docIds[this.targetStarts[at] + kept - 1]
    )
      flags &= ~2
    if (addedRows > 0 && this.segment.positions !== null) flags |= 4
    columns.sliceStart[ordinal] = this.targetStarts[at]
    columns.sliceClass[ordinal] = this.targetClasses[at]
    columns.lengths[ordinal] = kept + addedRows
    columns.docFrequency[ordinal] = this.frequencies[at] + Number(addedRows > 0)
    if (this.purging || isNew) columns.deadDocuments[ordinal] = 0
    columns.totalTermFrequency[ordinal] = (isNew ? 0 : columns.totalTermFrequency[ordinal]) + this.addedFrequencies[at]
    if (isNew) columns.surfaceOccurrences[ordinal] = 0
    columns.revision[ordinal] = isNew ? 0 : columns.revision[ordinal] + 1
    columns.flags[ordinal] = flags
  }

  private grow(): void {
    const capacity = this.ordinals.length * 2
    this.ordinals = grownColumn(this.ordinals, new Uint32Array(capacity))
    this.oldLengths = grownColumn(this.oldLengths, new Uint32Array(capacity))
    this.kept = grownColumn(this.kept, new Uint32Array(capacity))
    this.frequencies = grownColumn(this.frequencies, new Uint32Array(capacity))
    this.addedRows = grownColumn(this.addedRows, new Uint32Array(capacity))
    this.flags = grownColumn(this.flags, new Uint32Array(capacity))
    this.isNew = grownColumn(this.isNew, new Uint8Array(capacity))
    this.addedFrequencies = grownColumn(this.addedFrequencies, new Float64Array(capacity))
    this.firstTokens = grownColumn(this.firstTokens, new Uint32Array(capacity))
    this.tokenEnds = grownColumn(this.tokenEnds, new Uint32Array(capacity))
    this.sourceStarts = grownColumn(this.sourceStarts, new Uint32Array(capacity))
    this.sourceLengths = grownColumn(this.sourceLengths, new Uint32Array(capacity))
    this.sourceClasses = grownColumn(this.sourceClasses, new Uint32Array(capacity))
    this.targetStarts = grownColumn(this.targetStarts, new Uint32Array(capacity))
    this.targetClasses = grownColumn(this.targetClasses, new Uint32Array(capacity))
  }
}

let sparePostingPlan: PostingPlan | null = null

export function acquirePostingPlan(
  segment: NativeGrowingSegment,
  ordinal: number,
  tokens: TokenPlan,
  compact = false,
): PostingPlan {
  const plan = sparePostingPlan ?? new PostingPlan(segment, tokens)
  sparePostingPlan = null
  try {
    return plan.prepare(segment, ordinal, tokens, compact)
  } catch (error) {
    sparePostingPlan = plan
    throw error
  }
}

export function releasePostingPlan(plan: PostingPlan): void {
  sparePostingPlan = plan
}
