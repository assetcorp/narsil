import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import { POSTING_LIST_COMPACTION_THRESHOLD } from '../constants'
import { releaseSlice, trimClass, trimSlice } from './pools'
import { rowRemoved } from './postings'
import { requireSegment } from './status'
import { removeString, type StringPlan } from './strings'

interface RemovalChange {
  ordinal: number
  kept: number
  last: number
  sliceClass: number
  removedFrequency: number
  found: boolean
  compact: boolean
  ordered: boolean
}

function firstRow(segment: NativeGrowingSegment, token: number, document: number): number {
  let low = segment.columns.sliceStart[token]
  if ((segment.columns.flags[token] & 2) === 0) return low
  let high = low + segment.columns.lengths[token]
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (segment.postings.docIds[middle] < document) low = middle + 1
    else high = middle
  }
  return low
}

export class RemovalPlan {
  private readonly changes: RemovalChange[] = []
  private freedPositions = 0
  private freedRows: number

  constructor(
    private readonly segment: NativeGrowingSegment,
    private readonly document: number,
    private readonly terms: StringPlan,
  ) {
    const allocation = segment.postings.allocation
    requireSegment(allocation[0] <= segment.postings.docIds.length && allocation[1] <= allocation[0])
    this.freedRows = allocation[1]
    const positions = segment.positions
    if (positions !== null)
      requireSegment(
        positions.allocation[0] > 0 &&
          positions.allocation[0] <= positions.values.length &&
          positions.allocation[1] < positions.allocation[0],
      )
    for (const term of terms.entries) this.prepare(term.ordinal)
    if (positions !== null) requireSegment(this.freedPositions <= positions.allocation[0] - positions.allocation[1])
  }

  private prepare(token: number): void {
    const segment = this.segment
    const { columns, postings } = segment
    const start = columns.sliceStart[token]
    const length = columns.lengths[token]
    const kind = columns.sliceClass[token]
    const end = postings.allocation[0]
    const change: RemovalChange = {
      ordinal: token,
      kept: 0,
      last: 0,
      sliceClass: kind,
      removedFrequency: 0,
      found: false,
      compact: false,
      ordered: true,
    }
    this.changes.push(change)
    requireSegment(
      columns.docFrequency[token] >= columns.deadDocuments[token] &&
        columns.docFrequency[token] <= length &&
        Number.isFinite(columns.totalTermFrequency[token]) &&
        columns.totalTermFrequency[token] >= 0 &&
        Number.isFinite(columns.surfaceOccurrences[token]) &&
        columns.surfaceOccurrences[token] >= 0 &&
        start <= end,
    )
    if (kind === 255 && length === 0) return
    requireSegment(
      kind < postings.sliceCapacities.length &&
        postings.sliceCapacities[kind] <= end - start &&
        length <= postings.sliceCapacities[kind],
    )
    const ordered = (columns.flags[token] & 2) !== 0
    for (let at = firstRow(segment, token, this.document); at < start + length; at++) {
      const doc = postings.docIds[at]
      if (ordered && doc > this.document) break
      requireSegment(doc < segment.ordinalCapacity && postings.fieldIndices[at] < segment.partialFields.length)
      if (doc === this.document) {
        change.found = true
        change.removedFrequency += postings.frequencies[at]
      }
    }
    if (!change.found) return
    const live = columns.docFrequency[token] - columns.deadDocuments[token]
    requireSegment(live > 0)
    change.compact = live === 1 || (columns.deadDocuments[token] + 1) / length > POSTING_LIST_COMPACTION_THRESHOLD
    if (!change.compact) return
    for (let at = start; at < start + length; at++) {
      const doc = postings.docIds[at]
      requireSegment(doc < segment.ordinalCapacity && postings.fieldIndices[at] < segment.partialFields.length)
      if (doc === this.document || rowRemoved(segment, doc)) this.preparePositions(token, at)
      else {
        if (change.kept > 0 && doc < change.last) change.ordered = false
        change.last = doc
        change.kept++
      }
    }
    requireSegment((live === 1) === (change.kept === 0) && live - 1 <= change.kept)
    const capacities = postings.sliceCapacities
    if (change.kept > 0) change.sliceClass = trimClass(capacities, kind, change.kept)
    const retained = change.kept === 0 ? 0 : capacities[change.sliceClass]
    const released = capacities[kind] - retained
    requireSegment(released <= end - this.freedRows)
    this.freedRows += released
  }

  private preparePositions(token: number, row: number): void {
    const { positions, postings, columns } = this.segment
    if (positions === null || postings.positionStarts === null || (columns.flags[token] & 4) === 0) return
    const start = postings.positionStarts[row]
    if (start === 0) return
    const end = positions.allocation[0]
    requireSegment(start < end && positions.values[start] < end - start)
    const count = positions.values[start] + 1
    requireSegment(count <= 0xffffffff - this.freedPositions)
    this.freedPositions += count
  }

  publish(): void {
    const segment = this.segment
    const { columns, postings, positions } = segment
    const pool = { ...postings, values: postings.docIds }
    for (let at = 0; at < this.changes.length; at++) {
      const change = this.changes[at]
      if (!change.found) continue
      const token = change.ordinal
      columns.revision[token]++
      columns.deadDocuments[token]++
      columns.totalTermFrequency[token] = Math.max(0, columns.totalTermFrequency[token] - change.removedFrequency)
      if (!change.compact) continue
      this.compact(change)
      if (change.kept > 0 && columns.sliceClass[token] > change.sliceClass) {
        const kind = columns.sliceClass[token]
        trimSlice(
          pool,
          { start: columns.sliceStart[token], length: pool.sliceCapacities[kind], sliceClass: kind },
          change.sliceClass,
        )
        columns.sliceClass[token] = change.sliceClass
      }
      if (change.kept === 0) {
        const kind = columns.sliceClass[token]
        releaseSlice(pool, { start: columns.sliceStart[token], length: pool.sliceCapacities[kind], sliceClass: kind })
        removeString(segment.terms, this.terms.entries[at])
        columns.sliceClass[token] = 255
        columns.flags[token] = 0
        columns.totalTermFrequency[token] = 0
      }
    }
    if (positions !== null) positions.allocation[1] += this.freedPositions
  }

  private compact(change: RemovalChange): void {
    const { columns, postings } = this.segment
    const token = change.ordinal
    const start = columns.sliceStart[token]
    let into = start
    for (let at = start; at < start + columns.lengths[token]; at++) {
      const doc = postings.docIds[at]
      if (doc === this.document || rowRemoved(this.segment, doc)) continue
      postings.docIds[into] = doc
      postings.frequencies[into] = postings.frequencies[at]
      postings.fieldIndices[into] = postings.fieldIndices[at]
      if (postings.positionStarts !== null) postings.positionStarts[into] = postings.positionStarts[at]
      into++
    }
    columns.lengths[token] = change.kept
    columns.docFrequency[token] -= columns.deadDocuments[token]
    columns.deadDocuments[token] = 0
    columns.flags[token] = change.ordered ? columns.flags[token] | 2 : columns.flags[token] & ~2
  }
}
