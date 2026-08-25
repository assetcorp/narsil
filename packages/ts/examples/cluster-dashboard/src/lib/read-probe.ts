import { INDEX_NAME } from '../topology'
import { callNode, type NodeOutcome } from './node-client'
import type { CountProbe, CoverageRow, FacetBucketRow, FacetProbe, ReadProbeResult, SearchProbe } from './probe-types'

const FACET_FIELD = 'topic'
const FACET_LIMIT = 8
const SEARCH_LIMIT = 10

interface SearchResponse {
  hits?: unknown
  count?: unknown
  elapsed?: unknown
  coverage?: Partial<CoverageRow>
  facets?: Record<string, { values?: Record<string, number>; errorBound?: number }>
}

interface CountResponse {
  count?: unknown
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function coverageOf(value: Partial<CoverageRow> | undefined): CoverageRow | null {
  if (value === undefined) {
    return null
  }
  const { totalPartitions, queriedPartitions, timedOutPartitions, failedPartitions } = value
  if (
    typeof totalPartitions !== 'number' ||
    typeof queriedPartitions !== 'number' ||
    typeof timedOutPartitions !== 'number' ||
    typeof failedPartitions !== 'number'
  ) {
    return null
  }
  return { totalPartitions, queriedPartitions, timedOutPartitions, failedPartitions }
}

function searchProbeOf(outcome: NodeOutcome<SearchResponse>): SearchProbe {
  if (!outcome.ok) {
    return {
      ok: false,
      coverage: null,
      matchCount: null,
      returnedHits: null,
      elapsed: null,
      errorCode: outcome.failure?.code ?? null,
      errorMessage: outcome.failure?.message ?? null,
    }
  }
  return {
    ok: true,
    coverage: coverageOf(outcome.value?.coverage),
    matchCount: numberOrNull(outcome.value?.count),
    returnedHits: Array.isArray(outcome.value?.hits) ? outcome.value.hits.length : null,
    elapsed: numberOrNull(outcome.value?.elapsed),
    errorCode: null,
    errorMessage: null,
  }
}

function countProbeOf(outcome: NodeOutcome<CountResponse>): CountProbe {
  if (!outcome.ok) {
    return {
      ok: false,
      documentCount: null,
      errorCode: outcome.failure?.code ?? null,
      errorMessage: outcome.failure?.message ?? null,
    }
  }
  return { ok: true, documentCount: numberOrNull(outcome.value?.count), errorCode: null, errorMessage: null }
}

function facetProbeOf(outcome: NodeOutcome<SearchResponse>): FacetProbe {
  if (!outcome.ok) {
    return {
      ok: false,
      field: FACET_FIELD,
      buckets: [],
      errorBound: null,
      errorCode: outcome.failure?.code ?? null,
      errorMessage: outcome.failure?.message ?? null,
    }
  }

  const facet = outcome.value?.facets?.[FACET_FIELD]
  const buckets: FacetBucketRow[] = Object.entries(facet?.values ?? {})
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))

  return {
    ok: true,
    field: FACET_FIELD,
    buckets,
    errorBound: numberOrNull(facet?.errorBound),
    errorCode: null,
    errorMessage: null,
  }
}

export async function runReadProbe(nodeId: string, term: string): Promise<ReadProbeResult> {
  const [search, count, facets] = await Promise.all([
    callNode<SearchResponse>(nodeId, 'POST', `/indexes/${INDEX_NAME}/search`, { term, limit: SEARCH_LIMIT }),
    callNode<CountResponse>(nodeId, 'GET', `/indexes/${INDEX_NAME}/count`),
    callNode<SearchResponse>(nodeId, 'POST', `/indexes/${INDEX_NAME}/search`, {
      term,
      limit: 1,
      facets: { [FACET_FIELD]: { limit: FACET_LIMIT } },
    }),
  ])

  return {
    nodeId,
    term,
    ranAt: new Date().toISOString(),
    search: searchProbeOf(search),
    count: countProbeOf(count),
    facets: facetProbeOf(facets),
  }
}
