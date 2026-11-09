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
    const middle = low + ((high - low) >>> 1)
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

const UNCHECKED_INDEX = -2
const MALFORMED_INDEX = -3
const indexFieldLimits = new WeakMap<NativeFrozenSegment, number>()

function rowsAreOrdered(segment: NativeFrozenSegment, index: NonNullable<NativeFrozenSegment['removalIndex']>): number {
  const { postingDocuments, postingOffsets, postingFields, payloadSlots, terms } = segment
  const { starts, rows, termOfSlot } = index
  const slots = terms.counts.length
  const postings = postingDocuments.length
  if (postingOffsets[slots] > postings) return MALFORMED_INDEX
  for (let slot = 0; slot < slots; slot++) {
    const term = termOfSlot[slot]
    if (postingOffsets[slot] > postingOffsets[slot + 1] || term >= slots || payloadSlots[term] !== slot)
      return MALFORMED_INDEX
  }
  let widestField = -1
  for (let ordinal = 0; ordinal < segment.documentCount; ordinal++) {
    const end = starts[ordinal + 1]
    if (starts[ordinal] > end || end > postings) return MALFORMED_INDEX
    let previous = -1
    for (let at = starts[ordinal]; at < end; at++) {
      const row = rows[at]
      if (row <= previous || row < postingOffsets[0] || row >= postingOffsets[slots]) return MALFORMED_INDEX
      if (postingDocuments[row] !== ordinal) return MALFORMED_INDEX
      if (postingFields[row] > widestField) widestField = postingFields[row]
      previous = row
    }
  }
  return widestField
}

const checkedOccurrences = new WeakMap<Float64Array, boolean>()

function occurrencesAreCounts(occurrences: Float64Array): boolean {
  const held = checkedOccurrences.get(occurrences)
  if (held !== undefined) return held
  let counts = true
  for (let term = 0; term < occurrences.length && counts; term++)
    counts = Number.isFinite(occurrences[term]) && occurrences[term] >= 0
  checkedOccurrences.set(occurrences, counts)
  return counts
}

export function trustedIndexOf(
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
): NativeFrozenSegment['removalIndex'] {
  const index = segment.removalIndex
  if (index === null || !occurrencesAreCounts(state.removedOccurrences)) return null
  let widestField = indexFieldLimits.get(segment) ?? UNCHECKED_INDEX
  if (widestField === UNCHECKED_INDEX) {
    widestField = rowsAreOrdered(segment, index)
    indexFieldLimits.set(segment, widestField)
  }
  return widestField !== MALFORMED_INDEX && widestField < segment.partialFields.length ? index : null
}

export function subtractTrusted(
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  index: NonNullable<NativeFrozenSegment['removalIndex']>,
): void {
  const { postingOffsets, postingFrequencies } = segment
  const stored = segment.terms.counts
  const { starts, rows, termOfSlot } = index
  const { removedDocuments, removedOccurrences, pendingDocuments } = state
  const pending = state.pendingHeader[PENDING_DOCUMENTS]
  for (let document = 0; document < pending; document++) {
    const ordinal = pendingDocuments[document]
    let previousSlot = -1
    let term = 0
    for (let at = starts[ordinal]; at < starts[ordinal + 1]; at++) {
      const row = rows[at]
      const slot = slotOfRow(postingOffsets, row)
      if (slot !== previousSlot) {
        previousSlot = slot
        term = termOfSlot[slot]
        removedDocuments[term] = Math.min(stored[term], removedDocuments[term] + 1)
      }
      removedOccurrences[term] += postingFrequencies[row]
    }
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

export function requirePendingDocuments(
  changes: TermChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
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
}

export function settleTermCounts(
  changes: TermChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  paged: FrozenPagedRemovals | null,
): void {
  const pending = state.pendingHeader[PENDING_DOCUMENTS]
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
