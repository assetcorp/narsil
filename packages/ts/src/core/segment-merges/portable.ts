import type { NativeSegmentMergeCore } from '../../vector/native/types/segment-merge'
import { requireSegment, SegmentRefusal } from '../segment-writes/status'
import { prepareMerge } from './plan'
import { checkCapacity, publishMerge } from './publish'
import { captureInputs, captureMergeObject, captureOutput, MergeRegions, uint32 } from './regions'

export { mergePostings } from './postings'

function dimensions(documentCount: number, fieldCount: number): void {
  uint32(documentCount)
  uint32(fieldCount)
  requireSegment(fieldCount <= 65536)
}

export const measureMerge: NativeSegmentMergeCore['measureMerge'] = (
  rawInputs,
  documentCount,
  fieldCount,
  rawSizes,
  rawRetained = null,
) => {
  try {
    const captured = captureInputs(rawInputs)
    const retained = rawRetained === null ? null : captureMergeObject(rawRetained)
    dimensions(documentCount, fieldCount)
    const regions = new MergeRegions()
    const inputs = captured.map(input => regions.source(input))
    const sizes = regions.read(rawSizes, 'Uint32Array', 9, true)
    const terms = retained === null ? null : regions.strings(retained, 1)
    regions.check()
    const plan = prepareMerge(inputs, documentCount, fieldCount, terms)
    sizes.set(plan.sizes)
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}

export const writeMerge: NativeSegmentMergeCore['writeMerge'] = (
  rawInputs,
  documentCount,
  fieldCount,
  rawOutput,
  rawRetained = null,
) => {
  try {
    const captured = captureInputs(rawInputs)
    const target = captureOutput(rawOutput)
    const retained = rawRetained === null ? null : captureMergeObject(rawRetained)
    dimensions(documentCount, fieldCount)
    const regions = new MergeRegions()
    const inputs = captured.map(input => regions.source(input))
    const output = regions.output(target)
    const terms = retained === null ? null : regions.strings(retained, 1)
    regions.check()
    const plan = prepareMerge(inputs, documentCount, fieldCount, terms)
    checkCapacity(plan, documentCount, fieldCount, output)
    publishMerge(plan, inputs, documentCount, fieldCount, output)
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}
