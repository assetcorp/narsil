import type { NativeFieldMergeCore, NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { requireRoom, requireSegment, SegmentRefusal } from '../segment-writes/status'
import { typedRegion } from '../stored-values/regions'
import { capture, checkOverlap, type FieldMergePlan, readRegions, readSources } from './regions'

export function createFieldMerge(
  plan: (kind: number, sources: readonly NativeFieldMergeSource[], count: number) => FieldMergePlan,
): NativeFieldMergeCore {
  const measureFieldMerge: NativeFieldMergeCore['measureFieldMerge'] = (kind, inputs, count, sizes) => {
    try {
      const captured = capture(inputs)
      const sources = readSources(captured, kind)
      const output = typedRegion(sizes, 'Uint32Array')
      requireSegment(output !== null && output.length === 8)
      checkOverlap(sources, [output])
      const prepared = plan(kind, sources, count)
      output.set(prepared.lengths)
      return 0
    } catch (error) {
      if (error instanceof SegmentRefusal) return error.status
      throw error
    }
  }

  const writeFieldMerge: NativeFieldMergeCore['writeFieldMerge'] = (kind, inputs, count, target) => {
    try {
      const captured = capture(inputs)
      requireSegment(Array.isArray(target))
      const outputs = [...target]
      const sources = readSources(captured, kind)
      const output = readRegions(outputs, kind)
      checkOverlap(sources, output)
      const prepared = plan(kind, sources, count)
      for (let at = 0; at < output.length; at++) requireRoom(output[at].length >= prepared.lengths[at])
      prepared.publish(output)
      return 0
    } catch (error) {
      if (error instanceof SegmentRefusal) return error.status
      throw error
    }
  }
  return { measureFieldMerge, writeFieldMerge }
}
