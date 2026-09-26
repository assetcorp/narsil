import { ErrorCodes, NarsilError } from '../../errors'
import { DEFAULT_PAGE_SIZE } from '../../search/constants'
import { hitsKeptPerGroup } from '../../search/grouping'
import { clampRowCount } from '../../search/pagination'
import { normalizeSort } from '../../search/sorting'
import type { FacetResult, QueryCoverage, QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { FacetConfig, QueryParams } from '../../types/search'
import { MAX_FACET_SIZE, MAX_LIMIT } from '../query/constants'
import { DEFAULT_QUERY_CONFIG, type DistributedQueryResult } from '../query/types'
import type {
  SortField,
  WireGroupConfig,
  WireHybridConfig,
  WireQueryParams,
  WireVectorQueryParams,
} from '../transport/types'

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
    termMatch: wire.termMatch ?? undefined,
    prefixLength: wire.prefixLength ?? undefined,
    prefix: wire.prefix ?? undefined,
    exact: wire.exact ?? undefined,
    pinned:
      wire.pinned !== null ? wire.pinned.map(entry => ({ docId: entry.docId, position: entry.position })) : undefined,
    mode: wire.mode ?? undefined,
    limit: wire.limit,
    offset: wire.offset,
    searchAfter: wire.searchAfter ?? undefined,
    sort: convertWireSortToLocal(wire.sort),
    group: convertWireGroupToLocal(wire.group),
    facets: convertWireFacetConfigToLocal(wire.facets, facetShardSize ?? wire.facetSize),
    vector: convertWireVectorToLocal(wire.vector),
    hybrid: convertWireHybridToLocal(wire.hybrid),
  }
}

function convertWireGroupToLocal(group: WireGroupConfig | null): QueryParams['group'] {
  if (group === null) {
    return undefined
  }
  const local: NonNullable<QueryParams['group']> = { fields: [...group.fields], maxPerGroup: group.maxPerGroup }
  if (group.limit !== null) local.limit = group.limit
  return local
}

function convertWireVectorToLocal(vector: WireVectorQueryParams | null): QueryParams['vector'] {
  if (vector === null) {
    return undefined
  }
  const local: NonNullable<QueryParams['vector']> = { field: vector.field }
  if (vector.value !== null) local.value = vector.value
  if (vector.text !== null) local.text = vector.text
  if (vector.similarity !== null) local.similarity = vector.similarity
  if (vector.metric !== null) local.metric = vector.metric
  if (vector.efSearch !== null) local.efSearch = vector.efSearch
  if (vector.oversample !== null) local.oversample = vector.oversample
  return local
}

function convertWireHybridToLocal(hybrid: WireHybridConfig | null): QueryParams['hybrid'] {
  if (hybrid === null) {
    return undefined
  }
  const local: NonNullable<QueryParams['hybrid']> = {}
  if (hybrid.strategy !== null) local.strategy = hybrid.strategy
  if (hybrid.k !== null) local.k = hybrid.k
  if (hybrid.alpha !== null) local.alpha = hybrid.alpha
  return local
}

export function convertWireSortToLocal(wireSort: SortField[] | null): SortField[] | undefined {
  if (wireSort === null || wireSort.length === 0) {
    return undefined
  }
  return normalizeSort(wireSort)
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
    facetSize: wireFacetSize(params.facets),
    limit: clampRowCount(params.limit, DEFAULT_PAGE_SIZE),
    offset: clampRowCount(params.offset, 0),
    searchAfter: params.searchAfter ?? null,
    fields: params.fields ?? null,
    boost: params.boost ?? null,
    tolerance: params.tolerance ?? null,
    threshold: params.minScore ?? null,
    includeScores: params.includeScores ?? null,
    scoring: params.scoring ?? 'local',
    termMatch: params.termMatch ?? null,
    prefixLength: params.prefixLength ?? null,
    prefix: params.prefix ?? null,
    exact: params.exact ?? null,
    pinned:
      params.pinned !== undefined
        ? params.pinned.map(entry => ({ docId: entry.docId, position: entry.position }))
        : null,
    mode: params.mode ?? null,
    vector: convertLocalVectorToWire(params.vector),
    hybrid: convertLocalHybridToWire(params.hybrid),
  }
}

export function countIsExactFor(params: QueryParams): boolean {
  const vector = params.vector
  if (vector === undefined || (vector.value === undefined && vector.text === undefined)) return true
  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  if (params.mode === 'hybrid' || hasTerm) return false
  return vector.similarity === undefined
}

export function distributedCountIsExact(params: QueryParams, coverage: QueryCoverage): boolean {
  if (coverage.queriedPartitions < coverage.totalPartitions) return false
  if (coverage.timedOutPartitions > 0 || coverage.failedPartitions > 0) return false
  return countIsExactFor(params)
}

export function distributedResultToLocal<T = AnyDocument>(
  result: DistributedQueryResult,
  countExact: boolean,
  documents: Map<string, T> = new Map(),
  requestedFacets?: FacetConfig,
): QueryResult<T> {
  return {
    hits: result.scored.map(entry => ({
      id: entry.docId,
      score: entry.score ?? undefined,
      document: documents.get(entry.docId) ?? ({} as T),
    })),
    count: result.totalHits,
    countExact,
    elapsed: 0,
    cursor: result.cursor ?? undefined,
    facets: result.facets !== null ? convertWireFacetsToLocal(result, result.facets, requestedFacets) : undefined,
    coverage: result.coverage,
  }
}

function convertLocalSortToWire(sort: QueryParams['sort']): SortField[] | null {
  const fields = normalizeSort(sort)
  return fields.length === 0 ? null : fields
}

function convertLocalGroupToWire(group: QueryParams['group']): WireGroupConfig | null {
  if (group === undefined) {
    return null
  }
  return {
    fields: [...group.fields],
    maxPerGroup: group.reduce !== undefined ? MAX_LIMIT : hitsKeptPerGroup(group.maxPerGroup),
    limit: group.limit ?? null,
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
    metric: vector.metric ?? null,
    efSearch: vector.efSearch ?? null,
    oversample: vector.oversample ?? null,
  }
}

function convertLocalHybridToWire(hybrid: QueryParams['hybrid']): WireHybridConfig | null {
  if (hybrid === undefined) {
    return null
  }
  return {
    strategy: hybrid.strategy ?? null,
    k: hybrid.k ?? null,
    alpha: hybrid.alpha ?? null,
  }
}

function facetLimitOf(options: FacetConfig[string] | undefined): number {
  const limit = options?.limit
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_CONFIG.defaultFacetSize
  return Math.min(Math.max(Math.floor(limit), 1), MAX_FACET_SIZE)
}

export function requireClusterFacetOptions(facets: QueryParams['facets']): void {
  if (facets === undefined) return
  for (const [field, options] of Object.entries(facets)) {
    if (options.sort !== 'asc' && options.ranges === undefined) continue
    throw new NarsilError(
      ErrorCodes.CLUSTER_OPERATION_UNSUPPORTED,
      `A cluster search counts only the most frequent values of each facet field, highest first, so it cannot ${options.ranges !== undefined ? 'count ranges on' : 'order by the lowest counts first on'} facet "${field}"`,
      { field },
    )
  }
}

function wireFacetSize(facets: QueryParams['facets']): number | null {
  if (facets === undefined) return null
  let size = 0
  for (const options of Object.values(facets)) size = Math.max(size, facetLimitOf(options))
  return size === 0 ? null : size
}

function convertWireFacetsToLocal(
  result: DistributedQueryResult,
  wireFacets: Record<string, Array<{ value: string; count: number }>>,
  requested: FacetConfig | undefined,
): Record<string, FacetResult> {
  const converted: Record<string, FacetResult> = {}
  for (const [field, buckets] of Object.entries(wireFacets)) {
    const mergedBound = result.facetErrorBounds?.[field] ?? 0
    const kept = requested === undefined ? buckets.length : Math.min(buckets.length, facetLimitOf(requested[field]))
    const values: Record<string, number> = {}
    for (let index = 0; index < kept; index++) values[buckets[index].value] = buckets[index].count
    const errorBound =
      kept < buckets.length ? (result.facetUndercounts?.[field] ?? mergedBound) + buckets[kept].count : mergedBound
    converted[field] = { values, count: kept, errorBound: Math.max(errorBound, mergedBound) }
  }
  return converted
}
