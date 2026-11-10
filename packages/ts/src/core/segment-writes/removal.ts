import {
  POSTING_LIST_COMPACTION_THRESHOLD,
  releaseSlice,
  removeString,
  requireSegment,
  rowRemoved,
  trimClass,
  trimSlice,
} from '#platform/segment-removal-host'
import type { NativeGrowingSegment } from '../../vector/native/types/segments'

const NO_SLICE_CLASS = 255
const ORDERED_FLAG = 2
const POSITIONS_FLAG = 4

export interface RemovedTerms {
  readonly size: number
  readonly ordinals: Uint32Array
  readonly texts: readonly string[]
  readonly hashes: Uint32Array
}

function firstRow(docIds: Uint32Array, start: number, length: number, ordered: boolean, document: number): number {
  let low = start
  if (!ordered) return low
  let high = low + length
  while (low < high) {
    const middle = low + ((high - low) >>> 1)
    if (docIds[middle] < document) low = middle + 1
    else high = middle
  }
  return low
}

export class RemovalPlan {
  private found = new Uint8Array(0)
  private compacts = new Uint8Array(0)
  private ordered = new Uint8Array(0)
  private sliceClasses = new Uint8Array(0)
  private kept = new Uint32Array(0)
  private removedFrequencies = new Float64Array(0)
  private freedPositions = 0
  private freedRows = 0

  prepare(segment: NativeGrowingSegment, document: number, terms: RemovedTerms): void {
    this.reserve(terms.size)
    const allocation = segment.postings.allocation
    requireSegment(allocation[0] <= segment.postings.docIds.length && allocation[1] <= allocation[0])
    this.freedRows = allocation[1]
    this.freedPositions = 0
    const positions = segment.positions
    if (positions !== null)
      requireSegment(
        positions.allocation[0] > 0 &&
          positions.allocation[0] <= positions.values.length &&
          positions.allocation[1] < positions.allocation[0],
      )
    for (let at = 0; at < terms.size; at++) this.prepareTerm(segment, document, at, terms.ordinals[at])
    if (positions !== null) requireSegment(this.freedPositions <= positions.allocation[0] - positions.allocation[1])
  }

  private prepareTerm(segment: NativeGrowingSegment, document: number, at: number, token: number): void {
    const { columns, postings } = segment
    const start = columns.sliceStart[token]
    const length = columns.lengths[token]
    const kind = columns.sliceClass[token]
    const end = postings.allocation[0]
    this.found[at] = 0
    this.compacts[at] = 0
    this.removedFrequencies[at] = 0
    const docFrequency = columns.docFrequency[token]
    const totalTermFrequency = columns.totalTermFrequency[token]
    const surfaceOccurrences = columns.surfaceOccurrences[token]
    requireSegment(
      docFrequency >= columns.deadDocuments[token] &&
        docFrequency <= length &&
        Number.isFinite(totalTermFrequency) &&
        totalTermFrequency >= 0 &&
        Number.isFinite(surfaceOccurrences) &&
        surfaceOccurrences >= 0 &&
        start <= end,
    )
    if (kind === NO_SLICE_CLASS && length === 0) return
    requireSegment(
      kind < postings.sliceCapacities.length &&
        postings.sliceCapacities[kind] <= end - start &&
        length <= postings.sliceCapacities[kind],
    )
    const ordered = (columns.flags[token] & ORDERED_FLAG) !== 0
    const { docIds, fieldIndices, frequencies } = postings
    const ordinalCapacity = segment.ordinalCapacity
    const fieldCount = segment.partialFields.length
    let removedFrequency = 0
    let found = false
    for (let row = firstRow(docIds, start, length, ordered, document); row < start + length; row++) {
      const doc = docIds[row]
      if (ordered && doc > document) break
      requireSegment(doc < ordinalCapacity && fieldIndices[row] < fieldCount)
      if (doc === document) {
        found = true
        removedFrequency += frequencies[row]
      }
    }
    if (!found) return
    this.found[at] = 1
    this.removedFrequencies[at] = removedFrequency
    const dead = columns.deadDocuments[token]
    const live = docFrequency - dead
    requireSegment(live > 0)
    if (live !== 1 && (dead + 1) / length <= POSTING_LIST_COMPACTION_THRESHOLD) return
    this.compacts[at] = 1
    this.prepareCompaction(segment, document, at, token, live)
  }

  private prepareCompaction(
    segment: NativeGrowingSegment,
    document: number,
    at: number,
    token: number,
    live: number,
  ): void {
    const { columns, postings } = segment
    const start = columns.sliceStart[token]
    const length = columns.lengths[token]
    const kind = columns.sliceClass[token]
    let kept = 0
    let last = 0
    let ordered = 1
    for (let row = start; row < start + length; row++) {
      const doc = postings.docIds[row]
      requireSegment(doc < segment.ordinalCapacity && postings.fieldIndices[row] < segment.partialFields.length)
      if (doc === document || rowRemoved(segment, doc)) this.preparePositions(segment, token, row)
      else {
        if (kept > 0 && doc < last) ordered = 0
        last = doc
        kept++
      }
    }
    requireSegment((live === 1) === (kept === 0) && live - 1 <= kept)
    const capacities = postings.sliceCapacities
    const sliceClass = kept > 0 ? trimClass(capacities, kind, kept) : kind
    const retained = kept === 0 ? 0 : capacities[sliceClass]
    const released = capacities[kind] - retained
    requireSegment(released <= postings.allocation[0] - this.freedRows)
    this.freedRows += released
    this.kept[at] = kept
    this.ordered[at] = ordered
    this.sliceClasses[at] = sliceClass
  }

  private preparePositions(segment: NativeGrowingSegment, token: number, row: number): void {
    const { positions, postings, columns } = segment
    if (positions === null || postings.positionStarts === null || (columns.flags[token] & POSITIONS_FLAG) === 0) return
    const start = postings.positionStarts[row]
    if (start === 0) return
    const end = positions.allocation[0]
    requireSegment(start < end && positions.values[start] < end - start)
    const count = positions.values[start] + 1
    requireSegment(count <= 0xffffffff - this.freedPositions)
    this.freedPositions += count
  }

  publish(segment: NativeGrowingSegment, document: number, terms: RemovedTerms): void {
    const columns = segment.columns
    for (let at = 0; at < terms.size; at++) {
      if (this.found[at] === 0) continue
      const token = terms.ordinals[at]
      columns.revision[token]++
      columns.deadDocuments[token]++
      columns.totalTermFrequency[token] = Math.max(0, columns.totalTermFrequency[token] - this.removedFrequencies[at])
      if (this.compacts[at] === 1) this.publishCompaction(segment, document, terms, at, token)
    }
    if (segment.positions !== null) segment.positions.allocation[1] += this.freedPositions
  }

  private publishCompaction(
    segment: NativeGrowingSegment,
    document: number,
    terms: RemovedTerms,
    at: number,
    token: number,
  ): void {
    const { columns, postings } = segment
    this.compactRows(segment, document, at, token)
    const kept = this.kept[at]
    const sliceClass = this.sliceClasses[at]
    const kind = columns.sliceClass[token]
    if (kept > 0 && kind > sliceClass) {
      const pool = { ...postings, values: postings.docIds }
      trimSlice(
        pool,
        { start: columns.sliceStart[token], length: pool.sliceCapacities[kind], sliceClass: kind },
        sliceClass,
      )
      columns.sliceClass[token] = sliceClass
    }
    if (kept > 0) return
    const pool = { ...postings, values: postings.docIds }
    releaseSlice(pool, { start: columns.sliceStart[token], length: pool.sliceCapacities[kind], sliceClass: kind })
    removeString(segment.terms, terms.texts[at], token, terms.hashes[at])
    columns.sliceClass[token] = NO_SLICE_CLASS
    columns.flags[token] = 0
    columns.totalTermFrequency[token] = 0
  }

  private compactRows(segment: NativeGrowingSegment, document: number, at: number, token: number): void {
    const { columns, postings } = segment
    const start = columns.sliceStart[token]
    let into = start
    for (let row = start; row < start + columns.lengths[token]; row++) {
      const doc = postings.docIds[row]
      if (doc === document || rowRemoved(segment, doc)) continue
      postings.docIds[into] = doc
      postings.frequencies[into] = postings.frequencies[row]
      postings.fieldIndices[into] = postings.fieldIndices[row]
      if (postings.positionStarts !== null) postings.positionStarts[into] = postings.positionStarts[row]
      into++
    }
    columns.lengths[token] = this.kept[at]
    columns.docFrequency[token] -= columns.deadDocuments[token]
    columns.deadDocuments[token] = 0
    columns.flags[token] =
      this.ordered[at] === 1 ? columns.flags[token] | ORDERED_FLAG : columns.flags[token] & ~ORDERED_FLAG
  }

  private reserve(size: number): void {
    if (size <= this.found.length) return
    const capacity = Math.max(size, this.found.length * 2)
    this.found = new Uint8Array(capacity)
    this.compacts = new Uint8Array(capacity)
    this.ordered = new Uint8Array(capacity)
    this.sliceClasses = new Uint8Array(capacity)
    this.kept = new Uint32Array(capacity)
    this.removedFrequencies = new Float64Array(capacity)
  }
}
