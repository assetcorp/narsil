import { keptFacetValues } from '../core/partition/facet-limit'
import type { FacetConfig } from '../types/search'
import type * as FacetMerge from './facet-merge'
import { lazyCode } from './lazy-code'
import { oversampledShardSize } from './oversample'

type FacetFieldConfig = FacetConfig[string]

function keptValueCount(fieldConfig: FacetFieldConfig | undefined): number | undefined {
  return keptFacetValues(fieldConfig?.limit)
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
    if (fieldConfig?.ranges !== undefined || fieldConfig?.sort === 'asc') {
      widened[field] = { ...fieldConfig, limit: undefined }
      continue
    }
    const kept = keptValueCount(fieldConfig)
    widened[field] = kept === undefined ? fieldConfig : { ...fieldConfig, limit: oversampledShardSize(kept) }
  }
  return widened
}

const code = lazyCode('facet', () => import('./facet-merge'))

export function loadFacetMergesFor(facets: FacetConfig | undefined): Promise<void> | null {
  return facets === undefined ? null : code.load()
}

export const mergeFacets: typeof FacetMerge.mergeFacets = (...args) => code.get().mergeFacets(...args)
export const computeFacets: typeof FacetMerge.computeFacets = (...args) => code.get().computeFacets(...args)
export const requireFacetableFields: typeof FacetMerge.requireFacetableFields = (...args) =>
  code.get().requireFacetableFields(...args)
export const sortFacetedNumbers: typeof FacetMerge.sortFacetedNumbers = (...args) =>
  code.get().sortFacetedNumbers(...args)
export const countBooleanFacet: typeof FacetMerge.countBooleanFacet = (...args) => code.get().countBooleanFacet(...args)
export const countNumberFacet: typeof FacetMerge.countNumberFacet = (...args) => code.get().countNumberFacet(...args)
export const countEnumFacet: typeof FacetMerge.countEnumFacet = (...args) => code.get().countEnumFacet(...args)
