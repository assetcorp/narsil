import { type FacetBucket, mergeFacetBuckets } from '../core/merges/facet-buckets'
import {
  ErrorCodes,
  isGeopointOrVectorType,
  keptFacetValues,
  NarsilError,
  undeclaredFieldOnStrictIndex,
} from '../engine/optional-reads-host-bindings'
import type { FacetResult } from '../types/results'
import type { FacetConfig } from '../types/search'

export { countBooleanFacet, countEnumFacet, countNumberFacet, countRangeFacets } from '../core/facets/adapter'
export { computeFacets, sortFacetedNumbers } from '../core/partition/facets'

export function requireFacetableFields(
  facets: Record<string, unknown>,
  flatSchema: Record<string, string>,
  strict: boolean,
): void {
  for (const field of Object.keys(facets)) {
    const fieldType = flatSchema[field]
    if (strict && fieldType === undefined) throw undeclaredFieldOnStrictIndex(field, 'facet')
    if (isGeopointOrVectorType(fieldType)) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine counts the values of a text, number, boolean, or enum field, and the schema declares field "${field}" as "${fieldType}"`,
        { field, fieldType },
      )
    }
  }
}

export function mergeFacets(
  partitionFacets: Array<Record<string, FacetResult>>,
  config: FacetConfig,
): Record<string, FacetResult> {
  const fields = new Map<string, { lists: FacetBucket[][]; bounds: number[] }>()
  for (const partition of partitionFacets) {
    for (const [field, result] of Object.entries(partition)) {
      let merged = fields.get(field)
      if (merged === undefined) {
        merged = { lists: [], bounds: [] }
        fields.set(field, merged)
      }
      merged.lists.push(Object.entries(result.values).map(([value, count]) => ({ value, count })))
      merged.bounds.push(result.errorBound)
    }
  }
  const results: Record<string, FacetResult> = Object.create(null)
  for (const [field, merged] of fields) {
    const options = config[field]
    const answer = mergeFacetBuckets(
      merged.lists,
      merged.bounds,
      options?.sort === 'asc',
      keptFacetValues(options?.limit),
    )
    const values: Record<string, number> = Object.create(null)
    for (const bucket of answer.buckets) values[bucket.value] = bucket.count
    results[field] = { values, count: answer.buckets.length, errorBound: answer.errorBound }
  }
  return results
}
