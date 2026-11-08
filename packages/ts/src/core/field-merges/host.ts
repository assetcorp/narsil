import { measureFieldMerge, writeFieldMerge } from '#platform/field-merges'
import type { NativeFieldMergeRegion, NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { mergeFieldRegionsWith } from './output'

export function mergeFieldRegions(
  kind: number,
  sources: readonly NativeFieldMergeSource[],
  count: number,
): NativeFieldMergeRegion[] {
  return mergeFieldRegionsWith(kind, sources, count, { measureFieldMerge, writeFieldMerge })
}
