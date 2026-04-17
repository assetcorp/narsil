import type { QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { DistributedQueryResult } from '../query/types'
import type { SortField, WireQueryParams } from '../transport/types'

export function localParamsToWire(params: QueryParams): WireQueryParams {
  return {
    term: params.term ?? null,
    filters: (params.filters as Record<string, unknown> | undefined) ?? null,
    sort: convertLocalSortToWire(params.sort),
    group: convertLocalGroupToWire(params.group),
    facets: convertLocalFacetsToWire(params.facets),
    facetSize: null,
    limit: params.limit ?? 10,
    offset: params.offset ?? 0,
    searchAfter: params.searchAfter ?? null,
    fields: params.fields ?? null,
    boost: params.boost ?? null,
    tolerance: params.tolerance ?? null,
    threshold: params.minScore ?? null,
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
      score: entry.score,
      document: documents.get(entry.docId) ?? ({} as T),
    })),
    count: result.totalHits,
    elapsed: 0,
    cursor: result.cursor ?? undefined,
    facets: result.facets !== null ? convertWireFacetsToLocal(result.facets) : undefined,
  }
}

function convertLocalSortToWire(sort: Record<string, 'asc' | 'desc'> | undefined): SortField[] | null {
  if (sort === undefined) {
    return null
  }
  return Object.entries(sort).map(([field, direction]) => ({ field, direction }))
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

function convertLocalVectorToWire(
  vector: QueryParams['vector'],
): { field: string; value: number[] | null; text: string | null; k: number } | null {
  if (vector === undefined) {
    return null
  }
  return {
    field: vector.field,
    value: vector.value ?? null,
    text: vector.text ?? null,
    k: vector.similarity ?? 10,
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
): Record<string, { values: Record<string, number>; count: number }> {
  const result: Record<string, { values: Record<string, number>; count: number }> = {}
  for (const [field, buckets] of Object.entries(wireFacets)) {
    const values: Record<string, number> = {}
    let totalCount = 0
    for (const bucket of buckets) {
      values[bucket.value] = bucket.count
      totalCount += bucket.count
    }
    result[field] = { values, count: totalCount }
  }
  return result
}
