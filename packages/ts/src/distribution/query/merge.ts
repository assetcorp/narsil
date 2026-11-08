import { mergeEntries } from '../../core/merges/entries'
import { compareCodePoints, type SortDirection } from '../../core/ordering'
import { requireLoadedOptionalReads } from '../../engine/optional-reads-code'
import type { FacetBucket, ScoredEntry } from '../transport/types'
import { DEFAULT_MAX_FACET_BUCKETS } from './constants'

function ownField<T>(record: Record<string, T> | null | undefined, field: string): T | undefined {
  return record !== null && record !== undefined && Object.hasOwn(record, field) ? record[field] : undefined
}

export function mergeAndTruncateScoredEntries(arrays: ScoredEntry[][], limit: number): ScoredEntry[] {
  return mergeEntries(arrays, limit, (left, right) => compareCodePoints(left.docId, right.docId), true)
}

export function mergeAndTruncateSortedEntries(
  arrays: ScoredEntry[][],
  limit: number,
  directions: readonly SortDirection[],
): ScoredEntry[] {
  const { compareSortValues } = requireLoadedOptionalReads()
  return mergeEntries(
    arrays,
    limit,
    (left, right) =>
      compareSortValues(left.sortValues ?? [], right.sortValues ?? [], directions) ||
      compareCodePoints(left.docId, right.docId),
    false,
  )
}

/**
 * Merges the facet counts every node returned and adds up what each of them
 * left out.
 *
 * The summed node bounds limit how far any merged count falls below its true
 * count. A bucket that the truncation here drops can hold a merged count that
 * is itself short by that sum, so the field's bound adds the largest dropped
 * count to the sum, which keeps the true count of every dropped value within
 * the bound.
 *
 * @param allFacets - The buckets each node returned, keyed by field.
 * @param allBounds - The largest count each node left out, keyed by field.
 * @param maxBuckets - The buckets one field keeps.
 * @param ascending - The fields whose buckets order lowest count first.
 * @returns The merged buckets, one bound per field, and the summed node bounds that each field's bound starts from.
 */
export function mergeDistributedFacets(
  allFacets: Array<Record<string, FacetBucket[]>>,
  allBounds: Array<Record<string, number> | null | undefined>,
  maxBuckets: number = DEFAULT_MAX_FACET_BUCKETS,
  ascending: ReadonlySet<string> = new Set(),
): {
  facets: Record<string, FacetBucket[]>
  errorBounds: Record<string, number>
  undercounts: Record<string, number>
} {
  const fields = new Set<string>()
  for (const facetMap of allFacets) {
    for (const field of Object.keys(facetMap)) fields.add(field)
  }
  const facets: Record<string, FacetBucket[]> = Object.create(null)
  const errorBounds: Record<string, number> = Object.create(null)
  const undercounts: Record<string, number> = Object.create(null)
  for (const field of fields) {
    const count = Math.max(allFacets.length, allBounds.length)
    const lists = Array.from({ length: count }, (_, source) => ownField(allFacets[source], field) ?? [])
    const bounds = Array.from({ length: count }, (_, source) => ownField(allBounds[source], field) ?? 0)
    const merged = requireLoadedOptionalReads().mergeFacetBuckets(lists, bounds, ascending.has(field), maxBuckets)
    facets[field] = merged.buckets
    undercounts[field] = merged.undercount
    errorBounds[field] = merged.errorBound
  }

  return { facets, errorBounds, undercounts }
}
