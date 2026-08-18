import type { FacetResult } from '../types/results'

/**
 * Merges the facet counts of several partitions into one set, summing each
 * value's counts and each field's error bound.
 *
 * The bounds add rather than take the largest, because every partition
 * undercounts a value independently of the rest.
 *
 * @param partitionFacets - What each partition counted, keyed by field.
 * @returns The merged counts, keyed by field.
 */
export function mergeFacets(partitionFacets: Array<Record<string, FacetResult>>): Record<string, FacetResult> {
  const merged = new Map<string, Map<string, number>>()
  const bounds = new Map<string, number>()

  for (const partition of partitionFacets) {
    for (const [field, facetResult] of Object.entries(partition)) {
      let fieldMap = merged.get(field)
      if (!fieldMap) {
        fieldMap = new Map<string, number>()
        merged.set(field, fieldMap)
      }
      bounds.set(field, (bounds.get(field) ?? 0) + facetResult.errorBound)

      for (const [value, count] of Object.entries(facetResult.values)) {
        fieldMap.set(value, (fieldMap.get(value) ?? 0) + count)
      }
    }
  }

  const result: Record<string, FacetResult> = {}

  for (const [field, valueMap] of merged) {
    const values: Record<string, number> = {}
    for (const [value, count] of valueMap) {
      values[value] = count
    }
    result[field] = { values, count: valueMap.size, errorBound: bounds.get(field) ?? 0 }
  }

  return result
}
