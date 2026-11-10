import { mergeKeywords } from '#platform/segment-merges'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput, NativeKeywordMergeOutput } from '../../vector/native/types/segment-merge'
import { SegmentRefusal } from '../segment-writes/status'

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function refusal(status: number): Error {
  if (status === 8) return new SegmentRefusal(status)
  return new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The keyword segment refused a merge', { status })
}

function strings(count: number, bytes: number, stride: number): NativeFrozenStrings {
  return { text: new Uint8Array(bytes), offsets: new Uint32Array(count * stride + 1), counts: new Uint32Array(count) }
}

function allocate(sizes: Uint32Array, documents: number, fields: number): NativeKeywordMergeOutput {
  return {
    terms: strings(sizes[0], sizes[1], 1),
    postingOffsets: new Uint32Array(sizes[0] + 1),
    postingDocuments: new Uint32Array(sizes[2]),
    postingFrequencies: new Uint16Array(sizes[2]),
    postingFields: new Uint16Array(sizes[2]),
    positionOffsets: sizes[4] === 0 ? null : new Uint32Array(sizes[2] + 1),
    positionValues: sizes[4] === 0 ? null : new Uint32Array(sizes[3]),
    fieldLengths: new Uint32Array(documents * fields),
    totalFieldLengths: new Float64Array(fields),
    surfaces: strings(sizes[5], sizes[6], 2),
    spellings: strings(sizes[7], sizes[8], 2),
  }
}

export function mergeTextAt(table: NativeFrozenStrings, at: number): string {
  return decoder.decode(table.text.subarray(table.offsets[at], table.offsets[at + 1]))
}

export function mergeKeywordSources(
  sources: readonly NativeKeywordMergeInput[],
  documentCount: number,
  fieldCount: number,
  retainedTerms: NativeFrozenStrings | null = null,
): NativeKeywordMergeOutput {
  const merged = mergeKeywords(sources, documentCount, fieldCount, allocate, retainedTerms)
  if (typeof merged === 'number') throw refusal(merged)
  return merged
}
