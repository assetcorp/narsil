import type { ComparableSortValue, SortMode } from '../../ordering'
import type { PartitionReadState } from '../read-state'
import { prepareSortColumnsOf, type SortColumnsRequest, sortValuesOf } from '../sorting'

export function prepareCompositeSortColumns(subs: readonly PartitionReadState[], request: SortColumnsRequest): void {
  for (const sub of subs) prepareSortColumnsOf(sub, request)
}

export function compositeSortValues(
  subs: readonly PartitionReadState[],
  docId: string,
  fields: readonly string[],
  fieldTypes: readonly (string | undefined)[],
  modes: readonly SortMode[],
): ComparableSortValue[] {
  for (const sub of subs) {
    if (sub.docStore.has(docId)) {
      return sortValuesOf(sub, docId, fields, fieldTypes, modes)
    }
  }
  return fields.map(() => null)
}
