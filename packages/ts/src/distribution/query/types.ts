import type { FacetBucket, ScoredEntry } from '../transport/types'

export interface Coverage {
  totalPartitions: number
  queriedPartitions: number
  timedOutPartitions: number
  failedPartitions: number
}

export interface DistributedQueryConfig {
  allowPartialResults: boolean
  partitionTimeout: number
}

export const DEFAULT_QUERY_CONFIG: DistributedQueryConfig = {
  allowPartialResults: true,
  partitionTimeout: 5_000,
}

export interface DistributedQueryResult {
  scored: ScoredEntry[]
  totalHits: number
  facets: Record<string, FacetBucket[]> | null
  coverage: Coverage
}
