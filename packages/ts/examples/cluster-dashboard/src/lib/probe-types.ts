import type { QueryCoverage } from '@delali/narsil'

export interface FacetBucketRow {
  value: string
  count: number
}

export interface ProbeFailure {
  ok: false
  errorCode: string
  errorMessage: string
}

export type SearchProbe =
  | {
      ok: true
      coverage: QueryCoverage
      matchCount: number
      returnedHits: number
      elapsed: number
    }
  | ProbeFailure

export type CountProbe = { ok: true; documentCount: number } | ProbeFailure

export type FacetProbe =
  | {
      ok: true
      field: string
      buckets: FacetBucketRow[]
      errorBound: number
    }
  | ProbeFailure

export interface ReadProbeResult {
  nodeId: string
  term: string
  ranAt: string
  facetField: string
  search: SearchProbe
  count: CountProbe
  facets: FacetProbe
}

export interface ProvisionResult {
  indexCreated: boolean
  documentsIngested: number
  documentsFailed: number
  message: string
}
