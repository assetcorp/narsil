import { measureFieldMerge, writeFieldMerge } from '#platform/field-merges'
import { mergeFieldRegionsWith } from '#platform/segment-merge-host'
import type { NativeFieldMergeRegion, NativeFieldMergeSource } from '../../vector/native/types/field-merge'

export function mergeFieldRegions(
  kind: number,
  sources: readonly NativeFieldMergeSource[],
  count: number,
): NativeFieldMergeRegion[] {
  return mergeFieldRegionsWith(kind, sources, count, { measureFieldMerge, writeFieldMerge })
}
