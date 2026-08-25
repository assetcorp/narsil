export interface FacetBucketRow {
  value: string
  count: number
}

export interface CoverageRow {
  totalPartitions: number
  queriedPartitions: number
  timedOutPartitions: number
  failedPartitions: number
}

export interface SearchProbe {
  ok: boolean
  coverage: CoverageRow | null
  matchCount: number | null
  returnedHits: number | null
  elapsed: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface CountProbe {
  ok: boolean
  documentCount: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface FacetProbe {
  ok: boolean
  field: string
  buckets: FacetBucketRow[]
  errorBound: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface ReadProbeResult {
  nodeId: string
  term: string
  ranAt: string
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
