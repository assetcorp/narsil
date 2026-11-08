import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { rowRemoved } from '../segment-writes/postings'
import { requireSegment } from '../segment-writes/status'
import { storedText } from '../stored-values/text'
import type { MergePosting } from './plan'
import { mergeText } from './text'

export function sourceTermCount(input: NativeKeywordMergeInput): number {
  return input.growing?.terms.header[0] ?? input.terms.counts.length
}

export function sourceTerm(input: NativeKeywordMergeInput, ordinal: number) {
  const segment = input.growing
  if (segment == null) {
    const slot = input.payloadSlots[ordinal]
    if (slot >= input.terms.counts.length) return null
    const text = mergeText(input.terms, ordinal)
    if (text === null) return null
    const start = input.postingOffsets[slot]
    const end = input.postingOffsets[slot + 1]
    return start >= end || end > input.postingDocuments.length ? null : { text, start, end }
  }
  const { columns, terms, postings } = segment
  if ((columns.flags[ordinal] & 1) === 0) return null
  const from = terms.termOffset[ordinal]
  const length = terms.termLength[ordinal]
  const used = terms.header[4]
  const start = columns.sliceStart[ordinal]
  const rows = columns.lengths[ordinal]
  const end = postings.allocation[0]
  const kind = columns.sliceClass[ordinal]
  if (from > used || length > used - from || length > 0x40000000) return null
  if (length === 0 || rows === 0) return null
  if (
    end > postings.docIds.length ||
    start > end ||
    kind >= postings.sliceCapacities.length ||
    postings.sliceCapacities[kind] > end - start ||
    rows > postings.sliceCapacities[kind]
  )
    return null
  for (let at = from; at < from + length; at++) {
    const unit = terms.units[at]
    if (unit < 0xd800 || unit >= 0xe000) continue
    if (unit >= 0xdc00 || ++at >= from + length) return null
    if (terms.units[at] < 0xdc00 || terms.units[at] >= 0xe000) return null
  }
  return { text: storedText(terms.units, from, length), start, end: start + rows }
}

export function sourcePosting(
  input: NativeKeywordMergeInput,
  source: number,
  token: number,
  row: number,
): MergePosting | null {
  const segment = input.growing
  const document = segment == null ? input.postingDocuments[row] : segment.postings.docIds[row]
  const field = segment == null ? input.postingFields[row] : segment.postings.fieldIndices[row]
  if (document >= input.documentCount || field >= input.fieldMapping.length) {
    return null
  }
  if (input.mapping[document] === 0xffffffff || (segment != null && rowRemoved(segment, document))) return null
  const result: MergePosting = {
    input,
    row,
    source,
    target: input.mapping[document],
    field,
    frequency: segment == null ? input.postingFrequencies[row] : segment.postings.frequencies[row],
    positions: null,
    positionStart: 0,
    positionCount: 0,
  }
  if (segment == null) {
    if (input.positionOffsets !== null && input.positionValues !== null) {
      const start = input.positionOffsets[row]
      const end = input.positionOffsets[row + 1]
      if (start <= end && end <= input.positionValues.length) {
        result.positionStart = start
        result.positionCount = end - start
        result.positions = input.positionValues
      }
    }
  } else if (segment.positions !== null && (segment.columns.flags[token] & 4) !== 0) {
    const starts = segment.postings.positionStarts
    requireSegment(starts !== null)
    const start = starts[row]
    const end = segment.positions.allocation[0]
    if (end > segment.positions.values.length || start >= end) return result
    if (start === 0) return result
    const count = segment.positions.values[start]
    if (count >= end - start) return result
    result.positionStart = start + 1
    result.positionCount = count
    result.positions = segment.positions.values
  }
  return result
}
