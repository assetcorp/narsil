import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput, NativeKeywordMergeOutput } from '../../vector/native/types/segment-merge'
import { requireSegment, SegmentRefusal } from '../segment-writes/status'
import { prepareMerge } from './plan'
import { publishMerge } from './publish'
import { captureInputs, captureMergeObject, MergeRegions, uint32 } from './regions'

export { mergePostings } from './postings'

function dimensions(documentCount: number, fieldCount: number): void {
  uint32(documentCount)
  uint32(fieldCount)
  requireSegment(fieldCount <= 65536)
}

export type MergeOutputAllocator = (
  sizes: Uint32Array,
  documentCount: number,
  fieldCount: number,
) => NativeKeywordMergeOutput

export function mergeKeywords(
  rawInputs: readonly NativeKeywordMergeInput[],
  documentCount: number,
  fieldCount: number,
  allocate: MergeOutputAllocator,
  rawRetained: NativeFrozenStrings | null,
): NativeKeywordMergeOutput | number {
  try {
    const captured = captureInputs(rawInputs)
    const retained = rawRetained === null ? null : captureMergeObject(rawRetained)
    dimensions(documentCount, fieldCount)
    const regions = new MergeRegions()
    const inputs = captured.map(input => regions.source(input))
    const terms = retained === null ? null : regions.strings(retained, 1)
    regions.check()
    const plan = prepareMerge(inputs, documentCount, fieldCount, terms)
    const output = allocate(plan.sizes, documentCount, fieldCount)
    publishMerge(plan, inputs, documentCount, fieldCount, output)
    return output
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}
