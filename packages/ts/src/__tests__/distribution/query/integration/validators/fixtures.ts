import type { WireQueryParams } from '../../../../../distribution/transport/types'

export function makeWireQueryParams(overrides: Partial<WireQueryParams> = {}): WireQueryParams {
  return {
    term: null,
    filters: null,
    sort: null,
    group: null,
    facets: null,
    facetSize: null,
    limit: 10,
    offset: 0,
    searchAfter: null,
    fields: null,
    boost: null,
    tolerance: null,
    threshold: null,
    scoring: 'local',
    vector: null,
    hybrid: null,
    ...overrides,
  }
}

export function makeSearchPayload(
  paramOverrides: Partial<WireQueryParams> = {},
  outerOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    indexName: 'products',
    partitionIds: [0],
    params: makeWireQueryParams(paramOverrides),
    globalStats: null,
    facetShardSize: null,
    ...outerOverrides,
  }
}
