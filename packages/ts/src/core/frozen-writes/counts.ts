import type { NativeFrozenSegment } from '../../vector/native/types/frozen-segments'

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

export function removedTermCounts(segment: NativeFrozenSegment, ordinal: number): Map<number, number> {
  const counts = new Map<number, number>()
  if (segment.removalTerms != null) {
    for (let at = 0; at < segment.removalTerms.length; at += 2)
      counts.set(segment.removalTerms[at], segment.removalTerms[at + 1])
    return counts
  }
  const { removalIndex, postingDocuments, postingFrequencies, postingFields, postingOffsets, payloadSlots, terms } =
    segment
  if (removalIndex !== null) {
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
      if (
        slot >= terms.counts.length ||
        postingOffsets[slot] > row ||
        postingOffsets[slot + 1] > postingDocuments.length
      )
        continue
      const term = removalIndex.termOfSlot[slot]
      if (term >= terms.counts.length || payloadSlots[term] !== slot) continue
      counts.set(term, (counts.get(term) ?? 0) + postingFrequencies[row])
    }
    return counts
  }
  for (let term = 0; term < terms.counts.length; term++) {
    const slot = payloadSlots[term]
    if (slot >= terms.counts.length) continue
    const start = postingOffsets[slot]
    const end = postingOffsets[slot + 1]
    if (start > end || end > postingDocuments.length) continue
    let count = 0
    let found = false
    for (let row = start; row < end; row++) {
      if (postingDocuments[row] !== ordinal || postingFields[row] >= segment.partialFields.length) continue
      count += postingFrequencies[row]
      found = true
    }
    if (found) counts.set(term, count)
  }
  return counts
}
