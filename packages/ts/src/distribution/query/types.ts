import type { AllocationTable } from '../coordinator/types'
import type { FacetBucket, NodeTransport, ScoredEntry } from '../transport/types'

export interface Coverage {
  totalPartitions: number
  queriedPartitions: number
  timedOutPartitions: number
  failedPartitions: number
}

export interface DistributedQueryConfig {
  allowPartialResults: boolean
  partitionTimeout: number
  defaultFacetSize: number
}

export const DEFAULT_QUERY_CONFIG: DistributedQueryConfig = {
  allowPartialResults: true,
  partitionTimeout: 5_000,
  defaultFacetSize: 10,
}

export interface DistributedQueryResult {
  scored: ScoredEntry[]
  /**
   * For hybrid queries, totalHits reflects the text match count only, not the
   * total number of documents in the fused result set. Vector results contribute
   * to scored entries but are excluded from this count to avoid double-counting.
   */
  totalHits: number
  facets: Record<string, FacetBucket[]> | null
  cursor: string | null
  coverage: Coverage
}

export interface QueryRoutingDeps {
  transport: NodeTransport
  sourceNodeId: string
  getAllocation: (indexName: string) => Promise<AllocationTable | null>
}
