import type { FacetResult } from '../types/results'

export function mergeFacets(partitionFacets: Array<Record<string, FacetResult>>): Record<string, FacetResult> {
  const merged = new Map<string, Map<string, number>>()

  for (const partition of partitionFacets) {
    for (const [field, facetResult] of Object.entries(partition)) {
      let fieldMap = merged.get(field)
      if (!fieldMap) {
        fieldMap = new Map<string, number>()
        merged.set(field, fieldMap)
      }

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
    result[field] = { values, count: valueMap.size }
  }

  return result
}
