import {
  type ComparableSortValue,
  compareCodePoints,
  compareComparableValues,
  type SortDirection,
} from '../../ordering'
import type { PartitionReadState } from '../read-state'
import { type SortedPageEntry, type SortPageRequest, sortedPageOf, sortValuesOf } from '../sorting'
import { type OrdinalLayout, subMatchesView } from './filters'

function compareEntries(a: SortedPageEntry, b: SortedPageEntry, directions: readonly SortDirection[]): number {
  for (let i = 0; i < directions.length; i++) {
    const comparison = compareComparableValues(a.key[i] ?? null, b.key[i] ?? null, directions[i])
    if (comparison !== 0) return comparison
  }
  return compareCodePoints(a.id, b.id)
}

export function compositeSortedPage(
  subs: readonly PartitionReadState[],
  layout: OrdinalLayout,
  request: SortPageRequest,
): SortedPageEntry[] {
  const pages = subs.map((sub, index) =>
    sortedPageOf(sub, {
      ...request,
      matches: request.matches === null ? null : subMatchesView(request.matches, layout, index),
    }),
  )

  const merged = pages.flat()
  merged.sort((a, b) => compareEntries(a, b, request.directions))
  if (merged.length > request.limit) merged.length = request.limit
  return merged
}

export function compositeSortValues(
  subs: readonly PartitionReadState[],
  docId: string,
  fields: readonly string[],
  fieldTypes: readonly (string | undefined)[],
): ComparableSortValue[] {
  for (const sub of subs) {
    if (sub.docStore.has(docId)) {
      return sortValuesOf(sub, docId, fields, fieldTypes)
    }
  }
  return fields.map(() => null)
}
