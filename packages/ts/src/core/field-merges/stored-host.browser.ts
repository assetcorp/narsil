import type { NativeFieldMergeRegion, NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { requireSegment } from '../segment-writes/status'
import { createFieldMerge } from './operations'
import { mergeFieldRegionsWith } from './output'
import { documentsOf, uint32 } from './regions'
import { storedPlan } from './stored'

const core = createFieldMerge((kind, sources, count) => {
  requireSegment(kind === 5)
  uint32(count)
  return storedPlan(sources, documentsOf(sources, count))
})

export function mergeStoredFieldRegions(
  sources: readonly NativeFieldMergeSource[],
  count: number,
): NativeFieldMergeRegion[] {
  return mergeFieldRegionsWith(5, sources, count, core)
}
