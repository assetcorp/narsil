import { compareCodePoints } from '../../ordering'
import { compareComparableKeys } from '../../ordering/sort-comparison'
import type { PartitionReadState } from '../read-state'
import { type SortedPageEntry, type SortPageRequest, sortedPageOf } from '../sorting'
import { type OrdinalLayout, subMatchesView } from './filters'

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
  merged.sort((a, b) => compareComparableKeys(a.key, b.key, request.directions) || compareCodePoints(a.id, b.id))
  if (merged.length > request.limit) merged.length = request.limit
  return merged
}
