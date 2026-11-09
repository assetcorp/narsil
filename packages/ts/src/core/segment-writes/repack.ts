import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import {
  POOL_VACUUM_FREE_FRACTION,
  POOL_VACUUM_MIN_FREE_ENTRIES,
  POSITION_VACUUM_MIN_FREE_VALUES,
} from '../inverted-index/constants'
import { requireSegment } from './status'

const NO_SLICE_CLASS = 255
const TERM_LIVE = 1
const TERM_ORDERED = 2
const TERM_POSITIONS = 4
const NO_FREE_SLICE = 0xffffffff
export const NO_TERM = 0xffffffff

function sparse(allocation: Uint32Array | undefined, minimum: number): boolean {
  return (
    allocation !== undefined && allocation[1] >= minimum && allocation[1] > allocation[0] * POOL_VACUUM_FREE_FRACTION
  )
}

function sparsePositions(segment: NativeGrowingSegment): boolean {
  return sparse(segment.positions?.allocation, POSITION_VACUUM_MIN_FREE_VALUES)
}

export function sparsePools(segment: NativeGrowingSegment): boolean {
  return sparse(segment.postings.allocation, POOL_VACUUM_MIN_FREE_ENTRIES) || sparsePositions(segment)
}

function holdsNoSlice(segment: NativeGrowingSegment, ordinal: number): boolean {
  return segment.columns.sliceClass[ordinal] === NO_SLICE_CLASS && segment.columns.lengths[ordinal] === 0
}

export function validateSlices(segment: NativeGrowingSegment): void {
  const { columns, postings, terms } = segment
  const end = postings.allocation[0]
  const capacities = postings.sliceCapacities
  const starts = new Uint8Array(end)
  let live = 0
  for (let at = 0; at < terms.header[0]; at++) {
    if ((columns.flags[at] & TERM_LIVE) === 0) continue
    live++
    requireSegment(
      columns.docFrequency[at] >= columns.deadDocuments[at] &&
        columns.docFrequency[at] <= columns.lengths[at] &&
        Number.isFinite(columns.totalTermFrequency[at]) &&
        columns.totalTermFrequency[at] >= 0 &&
        Number.isFinite(columns.surfaceOccurrences[at]) &&
        columns.surfaceOccurrences[at] >= 0,
    )
    if (holdsNoSlice(segment, at)) continue
    const kind = columns.sliceClass[at]
    const start = columns.sliceStart[at]
    requireSegment(kind < capacities.length && start <= end)
    const size = capacities[kind]
    requireSegment(size <= end - start && columns.lengths[at] <= size)
    if (size === 0) continue
    requireSegment(starts[start] === 0)
    starts[start] = kind + 1
  }
  requireSegment(live === terms.header[1])
  let reach = 0
  for (let at = 0; at < end; at++) {
    const marked = starts[at]
    if (marked === 0) continue
    requireSegment(at >= reach)
    reach = at + capacities[marked - 1]
  }
}

export function preparePostingRepack(segment: NativeGrowingSegment): PostingRepack | null {
  return sparsePools(segment) ? new PostingRepack(segment, sparsePositions(segment)) : null
}

export class PostingRepack {
  readonly targetStarts: Uint32Array
  readonly targetClasses: Uint8Array
  readonly targetLengths: Uint32Array
  readonly targetFlags: Uint8Array
  private readonly docs: Uint32Array
  private readonly frequencies: Uint16Array
  private readonly fields: Uint16Array
  private readonly starts: Uint32Array | null
  private readonly positions: Uint32Array | null
  private rowCount = 0
  private positionCount = 1
  private freedPositions = 0

  constructor(
    private readonly segment: NativeGrowingSegment,
    rebuildPositions: boolean,
    private readonly mapping: Uint32Array | null = null,
  ) {
    validateSlices(segment)
    const count = segment.terms.header[0]
    const rows = segment.postings.allocation[0]
    this.targetStarts = new Uint32Array(count)
    this.targetClasses = new Uint8Array(count)
    this.targetLengths = new Uint32Array(count)
    this.targetFlags = new Uint8Array(count)
    this.docs = new Uint32Array(rows)
    this.frequencies = new Uint16Array(rows)
    this.fields = new Uint16Array(rows)
    this.starts = segment.postings.positionStarts === null ? null : new Uint32Array(rows)
    const positions = segment.positions
    this.positions = positions !== null && rebuildPositions ? new Uint32Array(positions.allocation[0]) : null
    for (let at = 0; at < count; at++) if (this.collects(at)) this.collectTerm(at)
    if (positions !== null && this.positions === null)
      requireSegment(this.freedPositions <= positions.allocation[0] - positions.allocation[1])
  }

  private collectTerm(ordinal: number): void {
    const { columns, postings } = this.segment
    const source = columns.sliceStart[ordinal]
    const target = this.rowCount
    const keepsPositions =
      this.starts !== null && this.segment.positions !== null && (columns.flags[ordinal] & TERM_POSITIONS) !== 0
    const { docIds, frequencies, fieldIndices } = postings
    const { docs, starts } = this
    const capacity = this.segment.ordinalCapacity
    const fieldCount = this.segment.partialFields.length
    const retired = this.segment.retired
    const sourceStarts = keepsPositions && this.positions === null ? postings.positionStarts : null
    let flags = columns.flags[ordinal] | TERM_ORDERED
    let kept = 0
    let last = 0
    const end = source + columns.lengths[ordinal]
    for (let row = source; row < end; row++) {
      const doc = docIds[row]
      const field = fieldIndices[row]
      if (doc >= capacity || field >= fieldCount) requireSegment(false)
      if ((retired[doc >>> 5] & (1 << (doc & 31))) !== 0) {
        if (keepsPositions && this.positions === null) this.releasePositions(row)
        continue
      }
      const output = target + kept
      if (kept > 0 && doc < last) flags &= ~TERM_ORDERED
      last = doc
      kept++
      docs[output] = doc
      this.frequencies[output] = frequencies[row]
      this.fields[output] = field
      if (starts !== null)
        starts[output] = sourceStarts !== null ? sourceStarts[row] : keepsPositions ? this.positionsFor(row) : 0
    }
    requireSegment(columns.docFrequency[ordinal] - columns.deadDocuments[ordinal] <= kept)
    const capacities = postings.sliceCapacities
    let sliceClass = 0
    while (sliceClass < capacities.length && capacities[sliceClass] < kept) sliceClass++
    requireSegment(sliceClass < capacities.length && capacities[sliceClass] <= postings.allocation[0] - target)
    this.targetStarts[ordinal] = target
    this.targetClasses[ordinal] = sliceClass
    this.targetLengths[ordinal] = kept
    this.targetFlags[ordinal] = flags
    this.rowCount = target + capacities[sliceClass]
  }

  private positionsFor(row: number): number {
    const starts = this.segment.postings.positionStarts
    const pool = this.segment.positions
    if (starts === null || pool === null) return 0
    const offset = starts[row]
    if (offset === 0 || this.positions === null) return offset
    const end = pool.allocation[0]
    requireSegment(offset < end && pool.values[offset] < end - offset)
    const length = pool.values[offset] + 1
    requireSegment(length <= end - this.positionCount)
    const target = this.positionCount
    this.positions.set(pool.values.subarray(offset, offset + length), target)
    this.positionCount += length
    return target
  }

  private releasePositions(row: number): void {
    const starts = this.segment.postings.positionStarts
    const pool = this.segment.positions
    if (starts === null || pool === null) return
    const offset = starts[row]
    if (offset === 0) return
    const end = pool.allocation[0]
    requireSegment(offset < end && pool.values[offset] < end - offset)
    this.freedPositions += pool.values[offset] + 1
  }

  private collects(ordinal: number): boolean {
    if (this.mapping !== null) return this.mapping[ordinal] !== NO_TERM
    return (this.segment.columns.flags[ordinal] & TERM_LIVE) !== 0 && !holdsNoSlice(this.segment, ordinal)
  }

  publish(): void {
    const columns = this.segment.columns
    for (let at = 0; at < this.targetStarts.length; at++) {
      if (!this.collects(at)) continue
      columns.sliceStart[at] = this.targetStarts[at]
      columns.sliceClass[at] = this.targetClasses[at]
      columns.lengths[at] = this.targetLengths[at]
      columns.docFrequency[at] -= columns.deadDocuments[at]
      columns.deadDocuments[at] = 0
      columns.revision[at] = (columns.revision[at] + 1) >>> 0
      columns.flags[at] = this.targetFlags[at]
    }
    this.publishRows()
  }

  publishRows(): void {
    const { postings, positions } = this.segment
    postings.docIds.set(this.docs.subarray(0, this.rowCount))
    postings.frequencies.set(this.frequencies.subarray(0, this.rowCount))
    postings.fieldIndices.set(this.fields.subarray(0, this.rowCount))
    if (this.starts !== null) postings.positionStarts?.set(this.starts.subarray(0, this.rowCount))
    postings.allocation[0] = this.rowCount
    postings.allocation[1] = 0
    postings.freeHeads.fill(NO_FREE_SLICE)
    if (positions === null) return
    if (this.positions === null) {
      positions.allocation[1] += this.freedPositions
      return
    }
    positions.values[0] = 0
    positions.values.set(this.positions.subarray(1, this.positionCount), 1)
    positions.allocation[0] = this.positionCount
    positions.allocation[1] = 0
  }
}
