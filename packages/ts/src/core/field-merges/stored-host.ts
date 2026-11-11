import type { NativeFieldMergeRegion, NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { mergeFieldRegions } from './host'

export function mergeStoredFieldRegions(
  sources: readonly NativeFieldMergeSource[],
  count: number,
): NativeFieldMergeRegion[] {
  return mergeFieldRegions(5, sources, count)
}
