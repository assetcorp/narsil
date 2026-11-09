import { PENDING_DOCUMENTS, requireSegment } from '#platform/frozen-kernel-host'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { FrozenPagedRemovals } from './types'

export interface TermChanges {
  readonly documents: Float64Array
  readonly amounts: Float64Array
  readonly marks: Float64Array
  readonly touched: number[]
  mark: number
  seen: Float64Array
  seenMark: number
}

export interface FrozenChanges {
  terms: TermChanges
  surfaces: Map<number, number>
  spellings: Map<number, number>
}

const termChangesByCounts = new WeakMap<Uint32Array, TermChanges>()

export function termChangesOf(segment: NativeFrozenSegment): TermChanges {
  const counts = segment.terms.counts
  const held = termChangesByCounts.get(counts)
  if (held !== undefined) return held
  const terms = counts.length
  const created: TermChanges = {
    documents: new Float64Array(terms),
    amounts: new Float64Array(terms),
    marks: new Float64Array(terms),
    touched: [],
    mark: 0,
    seen: new Float64Array(segment.documentCount),
    seenMark: 0,
  }
  termChangesByCounts.set(counts, created)
  return created
}

export function clearTermChanges(changes: TermChanges): void {
  for (const term of changes.touched) {
    changes.documents[term] = 0
    changes.amounts[term] = 0
  }
  changes.touched.length = 0
}

function slotOfRow(offsets: Uint32Array, row: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (offsets[middle + 1] <= row) low = middle + 1
    else high = middle
  }
  return low
}

function addTerm(changes: TermChanges, term: number, documents: number, amount: number): void {
  if (changes.documents[term] === 0) changes.touched.push(term)
  changes.documents[term] += documents
  changes.amounts[term] += amount
}

function addOccurrences(changes: TermChanges, term: number, amount: number): void {
  if (changes.marks[term] === changes.mark) {
    changes.amounts[term] += amount
    return
  }
  changes.marks[term] = changes.mark
  addTerm(changes, term, 1, amount)
}

function addIndexedDocument(changes: TermChanges, segment: NativeFrozenSegment, ordinal: number): void {
  const { removalIndex, postingDocuments, postingFrequencies, postingFields, postingOffsets, payloadSlots, terms } =
    segment
  if (removalIndex === null) return
  const start = removalIndex.starts[ordinal]
  const end = removalIndex.starts[ordinal + 1]
  if (start > end || end > postingDocuments.length) return
  changes.mark++
  let previous = -1
  for (let at = start; at < end; at++) {
    const row = removalIndex.rows[at]
    if (row >= postingDocuments.length || row <= previous) continue
    previous = row
    if (postingDocuments[row] !== ordinal || postingFields[row] >= segment.partialFields.length) continue
    const slot = slotOfRow(postingOffsets, row)
    if (slot >= terms.counts.length || postingOffsets[slot] > row || postingOffsets[slot + 1] > postingDocuments.length)
      continue
    const term = removalIndex.termOfSlot[slot]
    if (term >= terms.counts.length || payloadSlots[term] !== slot) continue
    addOccurrences(changes, term, postingFrequencies[row])
  }
}

function addPagedDocument(
  changes: TermChanges,
  segment: NativeFrozenSegment,
  paged: FrozenPagedRemovals,
  ordinal: number,
) {
  const pairs = paged.read(ordinal)
  changes.mark++
  for (let at = 0; at + 1 < pairs.length; at += 2) {
    requireSegment(pairs[at] < segment.terms.counts.length)
    addOccurrences(changes, pairs[at], pairs[at + 1])
  }
}

function scanPostings(changes: TermChanges, segment: NativeFrozenSegment, marks: Uint8Array): void {
  const { postingDocuments, postingFrequencies, postingFields, postingOffsets, payloadSlots, terms } = segment
  const stamps = new Uint32Array(marks.length)
  for (let term = 0; term < terms.counts.length; term++) {
    const slot = payloadSlots[term]
    if (slot >= terms.counts.length) continue
    const start = postingOffsets[slot]
    const end = postingOffsets[slot + 1]
    if (start > end || end > postingDocuments.length) continue
    const stamp = term + 1
    let documents = 0
    let amount = 0
    for (let row = start; row < end; row++) {
      const ordinal = postingDocuments[row]
      if (ordinal >= marks.length || marks[ordinal] === 0 || postingFields[row] >= segment.partialFields.length)
        continue
      amount += postingFrequencies[row]
      if (stamps[ordinal] !== stamp) {
        stamps[ordinal] = stamp
        documents++
      }
    }
    if (documents > 0) addTerm(changes, term, documents, amount)
  }
}

export function settleTermCounts(
  changes: TermChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  paged: FrozenPagedRemovals | null,
): void {
  const pending = state.pendingHeader[PENDING_DOCUMENTS]
  if (changes.seen.length !== segment.documentCount) changes.seen = new Float64Array(segment.documentCount)
  const { seen } = changes
  const stamp = ++changes.seenMark
  for (let at = 0; at < pending; at++) {
    const ordinal = state.pendingDocuments[at]
    requireSegment(
      ordinal < segment.documentCount &&
        (state.tombstones[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0 &&
        seen[ordinal] !== stamp,
    )
    seen[ordinal] = stamp
  }
  if (paged === null && segment.removalIndex === null) {
    const marks = new Uint8Array(segment.documentCount)
    for (let at = 0; at < pending; at++) marks[state.pendingDocuments[at]] = 1
    scanPostings(changes, segment, marks)
    return
  }
  for (let at = 0; at < pending; at++) {
    const ordinal = state.pendingDocuments[at]
    if (paged === null) addIndexedDocument(changes, segment, ordinal)
    else addPagedDocument(changes, segment, paged, ordinal)
  }
}
