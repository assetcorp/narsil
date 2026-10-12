import type { SegmentPostingColumns } from '../../core/partition/frozen/columns'
import type { KeywordSegmentArrays } from './types'

function slotsAreInTokenOrder(payloadSlots: Uint32Array): boolean {
  for (let at = 0; at < payloadSlots.length; at++) {
    if (payloadSlots[at] !== at) return false
  }
  return true
}

function reorderedPositions(
  arrays: KeywordSegmentArrays,
  postingOffsets: Uint32Array,
): Pick<SegmentPostingColumns, 'positionOffsets' | 'positionValues'> {
  const { positionOffsets, positionValues, tokenTable } = arrays
  if (positionOffsets === null || positionValues === null) return { positionOffsets: null, positionValues: null }
  const postings = postingOffsets[postingOffsets.length - 1]
  const offsets = new Uint32Array(postings + 1)
  const values = new Uint32Array(positionValues.length)
  let cursor = 0
  for (let token = 0; token < tokenTable.payloadSlots.length; token++) {
    const slot = tokenTable.payloadSlots[token]
    for (let from = arrays.postingOffsets[slot]; from < arrays.postingOffsets[slot + 1]; from++) {
      const to = postingOffsets[token] + (from - arrays.postingOffsets[slot])
      offsets[to] = cursor
      const start = positionOffsets[from]
      const end = positionOffsets[from + 1]
      values.set(positionValues.subarray(start, end), cursor)
      cursor += end - start
    }
  }
  offsets[postings] = cursor
  return { positionOffsets: offsets, positionValues: values }
}

export function postingsInTokenOrder(arrays: KeywordSegmentArrays): SegmentPostingColumns {
  const { tokenTable } = arrays
  if (slotsAreInTokenOrder(tokenTable.payloadSlots)) return arrays
  const tokens = tokenTable.payloadSlots.length
  const postingOffsets = new Uint32Array(tokens + 1)
  for (let token = 0; token < tokens; token++) {
    const slot = tokenTable.payloadSlots[token]
    postingOffsets[token + 1] = postingOffsets[token] + arrays.postingOffsets[slot + 1] - arrays.postingOffsets[slot]
  }
  const postings = postingOffsets[tokens]
  const postingDocIds = new Uint32Array(postings)
  const postingFrequencies = new Uint16Array(postings)
  const postingFieldIndices = new Uint16Array(postings)
  for (let token = 0; token < tokens; token++) {
    const slot = tokenTable.payloadSlots[token]
    const start = arrays.postingOffsets[slot]
    const end = arrays.postingOffsets[slot + 1]
    postingDocIds.set(arrays.postingDocIds.subarray(start, end), postingOffsets[token])
    postingFrequencies.set(arrays.postingFrequencies.subarray(start, end), postingOffsets[token])
    postingFieldIndices.set(arrays.postingFieldIndices.subarray(start, end), postingOffsets[token])
  }
  return {
    postingOffsets,
    postingDocIds,
    postingFrequencies,
    postingFieldIndices,
    ...reorderedPositions(arrays, postingOffsets),
  }
}
