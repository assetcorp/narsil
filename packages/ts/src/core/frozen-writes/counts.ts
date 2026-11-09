import { PENDING_DOCUMENTS, requireSegment } from '#platform/frozen-kernel-host'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { FrozenPagedRemovals } from './types'

export interface TermChange {
  documents: number
  amount: number
}

export interface FrozenChanges {
  terms: Map<number, TermChange>
  surfaces: Map<number, number>
  spellings: Map<number, number>
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

function addTerm(changes: FrozenChanges, term: number, documents: number, amount: number): void {
  const held = changes.terms.get(term)
  if (held === undefined) changes.terms.set(term, { documents, amount })
  else {
    held.documents += documents
    held.amount += amount
  }
}

function addDocument(changes: FrozenChanges, counts: ReadonlyMap<number, number>): void {
  for (const [term, amount] of counts) addTerm(changes, term, 1, amount)
}

function indexedCounts(segment: NativeFrozenSegment, ordinal: number): Map<number, number> {
  const counts = new Map<number, number>()
  const { removalIndex, postingDocuments, postingFrequencies, postingFields, postingOffsets, payloadSlots, terms } =
    segment
  if (removalIndex === null) return counts
  const start = removalIndex.starts[ordinal]
  const end = removalIndex.starts[ordinal + 1]
  if (start > end || end > postingDocuments.length) return counts
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
    counts.set(term, (counts.get(term) ?? 0) + postingFrequencies[row])
  }
  return counts
}

function pagedCounts(segment: NativeFrozenSegment, paged: FrozenPagedRemovals, ordinal: number) {
  const pairs = paged.read(ordinal)
  const counts = new Map<number, number>()
  for (let at = 0; at + 1 < pairs.length; at += 2) {
    requireSegment(pairs[at] < segment.terms.counts.length)
    counts.set(pairs[at], (counts.get(pairs[at]) ?? 0) + pairs[at + 1])
  }
  return counts
}

function scanPostings(changes: FrozenChanges, segment: NativeFrozenSegment, marks: Uint8Array): void {
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
  changes: FrozenChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  paged: FrozenPagedRemovals | null,
): void {
  const pending = state.pendingHeader[PENDING_DOCUMENTS]
  const seen = new Set<number>()
  for (let at = 0; at < pending; at++) {
    const ordinal = state.pendingDocuments[at]
    requireSegment(
      ordinal < segment.documentCount &&
        (state.tombstones[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0 &&
        !seen.has(ordinal),
    )
    seen.add(ordinal)
  }
  if (paged === null && segment.removalIndex === null) {
    const marks = new Uint8Array(segment.documentCount)
    for (const ordinal of seen) marks[ordinal] = 1
    scanPostings(changes, segment, marks)
    return
  }
  for (let at = 0; at < pending; at++) {
    const ordinal = state.pendingDocuments[at]
    addDocument(changes, paged === null ? indexedCounts(segment, ordinal) : pagedCounts(segment, paged, ordinal))
  }
}
