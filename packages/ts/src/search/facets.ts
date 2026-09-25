import { compareCodePoints } from '../core/ordering'
import { oversampledShardSize } from '../distribution/query/oversample'
import type { FacetResult } from '../types/results'
import type { FacetConfig } from '../types/search'

type FacetFieldConfig = FacetConfig[string]

function keptValueCount(fieldConfig: FacetFieldConfig | undefined): number | undefined {
  const limit = fieldConfig?.limit
  return limit !== undefined && limit > 0 ? Math.floor(limit) : undefined
}

export function everyValueFacetConfig(config: FacetConfig): FacetConfig {
  const widened: FacetConfig = {}
  for (const [field, fieldConfig] of Object.entries(config)) {
    widened[field] = { ...fieldConfig, limit: undefined }
  }
  return widened
}

export function oversampledFacetConfig(config: FacetConfig): FacetConfig {
  const widened: FacetConfig = {}
  for (const [field, fieldConfig] of Object.entries(config)) {
    const kept = keptValueCount(fieldConfig)
    widened[field] = kept === undefined ? fieldConfig : { ...fieldConfig, limit: oversampledShardSize(kept) }
  }
  return widened
}

export function mergeFacets(
  partitionFacets: Array<Record<string, FacetResult>>,
  config: FacetConfig,
): Record<string, FacetResult> {
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
    const fieldConfig = config[field]
    const ascending = fieldConfig?.sort === 'asc'
    const ordered = Array.from(valueMap.entries())
    ordered.sort((a, b) => (ascending ? a[1] - b[1] : b[1] - a[1]) || compareCodePoints(a[0], b[0]))

    const kept = Math.min(keptValueCount(fieldConfig) ?? ordered.length, ordered.length)
    let errorBound = bounds.get(field) ?? 0
    for (let index = kept; index < ordered.length; index++) {
      if (ordered[index][1] > errorBound) errorBound = ordered[index][1]
    }

    const values: Record<string, number> = {}
    for (let index = 0; index < kept; index++) {
      values[ordered[index][0]] = ordered[index][1]
    }
    result[field] = { values, count: kept, errorBound }
  }

  return result
}
