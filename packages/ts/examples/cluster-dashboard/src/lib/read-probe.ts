import type { FacetResult, QueryResult } from '@delali/narsil'
import { INDEX_NAME } from '../topology'
import { failureOf, nodeClient } from './node-client'
import type { CountProbe, FacetBucketRow, FacetProbe, ProbeFailure, ReadProbeResult, SearchProbe } from './probe-types'

const FACET_FIELD = 'topic'
const FACET_LIMIT = 8
const SEARCH_LIMIT = 10

function refusalOf(error: unknown): ProbeFailure {
  const failure = failureOf(error)
  return { ok: false, errorCode: failure.code, errorMessage: failure.message }
}

function searchProbeOf(result: QueryResult): SearchProbe {
  return {
    ok: true,
    coverage: result.coverage,
    matchCount: result.count,
    returnedHits: result.hits.length,
    elapsed: result.elapsed,
  }
}

function bucketsOf(facet: FacetResult | undefined): FacetBucketRow[] {
  return Object.entries(facet?.values ?? {})
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
}

function facetProbeOf(result: QueryResult): FacetProbe {
  const facet = result.facets?.[FACET_FIELD]
  return {
    ok: true,
    field: FACET_FIELD,
    buckets: bucketsOf(facet),
    errorBound: facet?.errorBound ?? 0,
  }
}

function countProbeOf(documentCount: number): CountProbe {
  return { ok: true, documentCount }
}

/**
 * Sends one term to a single node three ways, and reports what each read answered.
 *
 * The search answers with the coverage the engine measured, the count refuses outright while a partition has no
 * reachable copy, and the faceted search carries the largest undercount each field can hold, so the three answers
 * together show how far a fault reaches into a read.
 *
 * @param nodeId - The node to read through.
 * @param term - The term to search for.
 * @returns The three answers, each carrying either its figures or the code the node refused under.
 */
export async function runReadProbe(nodeId: string, term: string): Promise<ReadProbeResult> {
  const client = nodeClient(nodeId)
  const [search, count, facets] = await Promise.allSettled([
    client.query(INDEX_NAME, { term, limit: SEARCH_LIMIT }),
    client.countDocuments(INDEX_NAME),
    client.query(INDEX_NAME, { term, limit: 1, facets: { [FACET_FIELD]: { limit: FACET_LIMIT } } }),
  ])

  return {
    nodeId,
    term,
    ranAt: new Date().toISOString(),
    facetField: FACET_FIELD,
    search: search.status === 'fulfilled' ? searchProbeOf(search.value) : refusalOf(search.reason),
    count: count.status === 'fulfilled' ? countProbeOf(count.value) : refusalOf(count.reason),
    facets: facets.status === 'fulfilled' ? facetProbeOf(facets.value) : refusalOf(facets.reason),
  }
}
