import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { rowRemoved } from '../segment-writes/postings'
import { requireSegment } from '../segment-writes/status'
import { storedText } from '../stored-values/text'
import { mergeTextBytes } from './text'

const encoder = new TextEncoder()

export function sourceTermCount(input: NativeKeywordMergeInput): number {
  return input.growing?.terms.header[0] ?? input.terms.counts.length
}

export interface SourceTerm {
  text: string | null
  bytes: Uint8Array
  start: number
  end: number
}

export function sourceTerm(input: NativeKeywordMergeInput, ordinal: number): SourceTerm | null {
  const segment = input.growing
  if (segment == null) {
    const slot = input.payloadSlots[ordinal]
    if (slot >= input.terms.counts.length) return null
    const bytes = mergeTextBytes(input.terms, ordinal)
    if (bytes === null) return null
    const start = input.postingOffsets[slot]
    const end = input.postingOffsets[slot + 1]
    return start >= end || end > input.postingDocuments.length ? null : { text: null, bytes, start, end }
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
  const text = storedText(terms.units, from, length)
  return { text, bytes: encoder.encode(text), start, end: start + rows }
}

export interface PostingRead {
  target: number
  field: number
  frequency: number
  positions: Uint32Array | null
  positionStart: number
  positionCount: number
}

export function createPostingRead(): PostingRead {
  return { target: 0, field: 0, frequency: 0, positions: null, positionStart: 0, positionCount: 0 }
}

export function readPosting(input: NativeKeywordMergeInput, token: number, row: number, read: PostingRead): boolean {
  const segment = input.growing
  const document = segment == null ? input.postingDocuments[row] : segment.postings.docIds[row]
  const field = segment == null ? input.postingFields[row] : segment.postings.fieldIndices[row]
  if (document >= input.documentCount || field >= input.fieldMapping.length) return false
  const target = input.mapping[document]
  if (target === 0xffffffff || (segment != null && rowRemoved(segment, document))) return false
  read.target = target
  read.field = field
  read.frequency = segment == null ? input.postingFrequencies[row] : segment.postings.frequencies[row]
  read.positions = null
  read.positionStart = 0
  read.positionCount = 0
  if (segment == null) {
    if (input.positionOffsets !== null && input.positionValues !== null) {
      const start = input.positionOffsets[row]
      const end = input.positionOffsets[row + 1]
      if (start <= end && end <= input.positionValues.length) {
        read.positionStart = start
        read.positionCount = end - start
        read.positions = input.positionValues
      }
    }
  } else if (segment.positions !== null && (segment.columns.flags[token] & 4) !== 0) {
    const starts = segment.postings.positionStarts
    requireSegment(starts !== null)
    const start = starts[row]
    const end = segment.positions.allocation[0]
    if (end > segment.positions.values.length || start >= end || start === 0) return true
    const count = segment.positions.values[start]
    if (count >= end - start) return true
    read.positionStart = start + 1
    read.positionCount = count
    read.positions = segment.positions.values
  }
  return true
}
