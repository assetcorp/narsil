import { everyValueFacetConfig, mergeFacets } from '../../../search/facets'
import type { FacetResult } from '../../../types/results'
import type { SchemaDefinition } from '../../../types/schema'
import type { FacetConfig } from '../../../types/search'
import { computeFacets, type FacetMatchSet } from '../facets'
import type { PartitionReadState } from '../read-state'
import { type OrdinalLayout, subBitsetView } from './filters'

export function compositeFacets(
  subs: readonly PartitionReadState[],
  layout: () => OrdinalLayout,
  matched: FacetMatchSet,
  config: FacetConfig,
  schema: SchemaDefinition,
): Record<string, FacetResult> {
  const everyValue = everyValueFacetConfig(config)
  if ('ordinalBitset' in matched) {
    const ordinalLayout = layout()
    return mergeFacets(
      subs.map((sub, index) =>
        computeFacets(
          sub,
          { ordinalBitset: subBitsetView(matched.ordinalBitset, ordinalLayout, index) },
          everyValue,
          schema,
        ),
      ),
      config,
    )
  }
  return mergeFacets(
    subs.map(sub => computeFacets(sub, matched, everyValue, schema)),
    config,
  )
}
