import { clampRowCount, DEFAULT_PAGE_SIZE } from '../../search/pagination'
import { normalizeSort } from '../../search/sorting'
import type { FacetResult, QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { FacetConfig, QueryParams } from '../../types/search'
import type { DistributedQueryResult } from '../query/types'
import type { SortField, WireQueryParams, WireVectorQueryParams } from '../transport/types'

export function wireParamsToLocal(wire: WireQueryParams, facetShardSize?: number | null): QueryParams {
  return {
    term: wire.term ?? undefined,
    fields: wire.fields ?? undefined,
    filters: wire.filters ?? undefined,
    boost: wire.boost ?? undefined,
    scoring: wire.scoring,
    tolerance: wire.tolerance ?? undefined,
    minScore: wire.threshold ?? undefined,
    includeScores: wire.includeScores ?? undefined,
    limit: wire.limit,
    offset: wire.offset,
    searchAfter: wire.searchAfter ?? undefined,
    sort: convertWireSortToLocal(wire.sort),
    group: wire.group !== null ? { fields: [wire.group.field], maxPerGroup: wire.group.maxPerGroup } : undefined,
    facets: convertWireFacetConfigToLocal(wire.facets, facetShardSize ?? wire.facetSize),
    vector:
      wire.vector !== null
        ? {
            field: wire.vector.field,
            value: wire.vector.value ?? undefined,
            text: wire.vector.text ?? undefined,
            similarity: wire.vector.similarity ?? undefined,
          }
        : undefined,
    hybrid:
      wire.hybrid !== null ? { strategy: wire.hybrid.strategy, k: wire.hybrid.k, alpha: wire.hybrid.alpha } : undefined,
  }
}

export function convertWireSortToLocal(wireSort: SortField[] | null): SortField[] | undefined {
  if (wireSort === null || wireSort.length === 0) {
    return undefined
  }
  return wireSort.map(entry => ({ field: entry.field, direction: entry.direction }))
}

export function convertWireFacetConfigToLocal(facets: string[] | null, limit: number | null): FacetConfig | undefined {
  if (facets === null || facets.length === 0) {
    return undefined
  }
  const result: FacetConfig = {}
  for (const field of facets) {
    result[field] = limit !== null ? { limit } : {}
  }
  return result
}

export function localParamsToWire(params: QueryParams): WireQueryParams {
  return {
    term: params.term ?? null,
    filters: (params.filters as Record<string, unknown> | undefined) ?? null,
    sort: convertLocalSortToWire(params.sort),
    group: convertLocalGroupToWire(params.group),
    facets: convertLocalFacetsToWire(params.facets),
    facetSize: null,
    limit: clampRowCount(params.limit, DEFAULT_PAGE_SIZE),
    offset: clampRowCount(params.offset, 0),
    searchAfter: params.searchAfter ?? null,
    fields: params.fields ?? null,
    boost: params.boost ?? null,
    tolerance: params.tolerance ?? null,
    threshold: params.minScore ?? null,
    includeScores: params.includeScores ?? null,
    scoring: params.scoring ?? 'local',
    vector: convertLocalVectorToWire(params.vector),
    hybrid: convertLocalHybridToWire(params.hybrid),
  }
}

export function distributedResultToLocal<T = AnyDocument>(
  result: DistributedQueryResult,
  documents: Map<string, T> = new Map(),
): QueryResult<T> {
  return {
    hits: result.scored.map(entry => ({
      id: entry.docId,
      score: entry.score ?? undefined,
      document: documents.get(entry.docId) ?? ({} as T),
    })),
    count: result.totalHits,
    elapsed: 0,
    cursor: result.cursor ?? undefined,
    facets: result.facets !== null ? convertWireFacetsToLocal(result.facets, result.facetErrorBounds) : undefined,
  }
}

function convertLocalSortToWire(sort: QueryParams['sort']): SortField[] | null {
  const fields = normalizeSort(sort)
  return fields.length === 0 ? null : fields
}

function convertLocalGroupToWire(group: QueryParams['group']): { field: string; maxPerGroup: number } | null {
  if (group === undefined) {
    return null
  }
  return {
    field: group.fields[0],
    maxPerGroup: group.maxPerGroup ?? 1,
  }
}

function convertLocalFacetsToWire(facets: QueryParams['facets']): string[] | null {
  if (facets === undefined) {
    return null
  }
  return Object.keys(facets)
}

function convertLocalVectorToWire(vector: QueryParams['vector']): WireVectorQueryParams | null {
  if (vector === undefined) {
    return null
  }
  return {
    field: vector.field,
    value: vector.value === undefined ? null : Array.from(vector.value),
    text: vector.text ?? null,
    similarity: vector.similarity ?? null,
  }
}

function convertLocalHybridToWire(
  hybrid: QueryParams['hybrid'],
): { strategy: 'rrf' | 'linear'; k: number; alpha: number } | null {
  if (hybrid === undefined) {
    return null
  }
  return {
    strategy: hybrid.strategy ?? 'rrf',
    k: hybrid.k ?? 60,
    alpha: hybrid.alpha ?? 0.5,
  }
}

function convertWireFacetsToLocal(
  wireFacets: Record<string, Array<{ value: string; count: number }>>,
  errorBounds: Record<string, number> | null,
): Record<string, FacetResult> {
  const result: Record<string, FacetResult> = {}
  for (const [field, buckets] of Object.entries(wireFacets)) {
    const values: Record<string, number> = {}
    let totalCount = 0
    for (const bucket of buckets) {
      values[bucket.value] = bucket.count
      totalCount += bucket.count
    }
    result[field] = { values, count: totalCount, errorBound: errorBounds?.[field] ?? 0 }
  }
  return result
}
