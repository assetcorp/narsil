import type { QueryCoverage } from '../../types/results'
import type { AllocationTable } from '../coordinator/types'
import type { NodeRegistration } from '../coordinator/types/node'
import type { FacetBucket, NodeTransport, ScoredEntry, WireGroupEntry } from '../transport/types'
import type { SearchContextSet } from './search-contexts'

export interface DistributedQueryConfig {
  allowPartialResults: boolean
  partitionTimeout: number
  defaultFacetSize: number
  searchContexts: boolean
}

export const DEFAULT_QUERY_CONFIG: DistributedQueryConfig = {
  allowPartialResults: true,
  partitionTimeout: 5_000,
  defaultFacetSize: 10,
  searchContexts: false,
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
  facetErrorBounds: Record<string, number> | null
  facetUndercounts?: Record<string, number> | null
  groups: WireGroupEntry[] | null
  cursor: string | null
  coverage: QueryCoverage
  pinnedFromOutside?: string[]
  mergeHeldEveryMatch?: boolean
  contexts?: SearchContextSet
}

export interface QueryRoutingDeps {
  transport: NodeTransport
  sourceNodeId: string
  getAllocation: (indexName: string) => Promise<AllocationTable | null>
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>
  listNodes?: () => Promise<NodeRegistration[]>
}

export interface RoutingResult {
  nodeToPartitions: Map<string, number[]>
  copiesByPartition: Map<number, string[]>
  unavailablePartitions: number[]
}
