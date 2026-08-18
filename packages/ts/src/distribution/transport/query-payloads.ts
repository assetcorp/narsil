export interface SortField {
  field: string
  direction: 'asc' | 'desc'
}

export interface WireGroupConfig {
  field: string
  maxPerGroup: number
}

export interface WireVectorQueryParams {
  field: string
  value: number[] | null
  text: string | null
  similarity: number | null
}

export interface WireHybridConfig {
  strategy: 'rrf' | 'linear'
  k: number
  alpha: number
}

export interface WireQueryParams {
  term: string | null
  filters: Record<string, unknown> | null
  sort: SortField[] | null
  group: WireGroupConfig | null
  facets: string[] | null
  facetSize: number | null
  limit: number
  offset: number
  searchAfter: string | null
  fields: string[] | null
  boost: Record<string, number> | null
  tolerance: number | null
  threshold: number | null
  includeScores: boolean | null
  scoring: 'local' | 'dfs' | 'broadcast'
  vector: WireVectorQueryParams | null
  hybrid: WireHybridConfig | null
}

export interface GlobalStatistics {
  totalDocuments: number
  docFrequencies: Record<string, number>
  totalFieldLengths: Record<string, number>
  averageFieldLengths: Record<string, number>
}

export interface WireHighlightConfig {
  fields: string[] | null
  before: string
  after: string
  maxSnippetLength: number
}

export interface ScoredEntry {
  docId: string
  score: number | null
  sortValues: unknown[] | null
}

export interface FacetBucket {
  value: string
  count: number
}

export interface PartitionSearchResult {
  partitionId: number
  scored: ScoredEntry[]
  totalHits: number
}

export interface SearchPayload {
  indexName: string
  partitionIds: number[]
  params: WireQueryParams
  globalStats: GlobalStatistics | null
  facetShardSize: number | null
}

export interface SearchResultPayload {
  results: PartitionSearchResult[]
  facets: Record<string, FacetBucket[]> | null
  facetErrorBounds: Record<string, number> | null
}

export interface FetchDocumentId {
  docId: string
  partitionId: number
}

export interface FetchPayload {
  indexName: string
  documentIds: FetchDocumentId[]
  fields: string[] | null
  highlight: WireHighlightConfig | null
}

export interface FetchedDocument {
  docId: string
  document: Record<string, unknown>
  highlights: Record<string, string[]> | null
}

export interface FetchResultPayload {
  documents: FetchedDocument[]
}

export interface StatsPayload {
  indexName: string
  partitionIds: number[]
  terms: string[]
}

export interface StatsResultPayload {
  totalDocuments: number
  docFrequencies: Record<string, number>
  totalFieldLengths: Record<string, number>
}

export interface CountPayload {
  indexName: string
  partitionIds: number[]
}

export interface PartitionCountEntry {
  partitionId: number
  documentCount: number
  estimatedMemoryBytes: number
}

export interface CountResultPayload {
  partitions: PartitionCountEntry[]
  language: string
}

export interface ListPayload {
  indexName: string
  partitionIds: number[]
  cursor: string | null
  limit: number
  filters: Record<string, unknown> | null
  sort: SortField[] | null
  fields: string[] | null
}

export interface ListEntryWire {
  docId: string
  document: Record<string, unknown>
  sortValues: unknown[] | null
}

export interface ListResultPayload {
  entries: ListEntryWire[]
  total: number
  hasMore: boolean
}

export interface SuggestPayload {
  indexName: string
  partitionIds: number[]
  prefix: string
  limit: number
}

export interface SuggestResultPayload {
  terms: Array<{ term: string; documentFrequency: number }>
  analysisStale: boolean
}

export interface PreflightPayload {
  indexName: string
  partitionIds: number[]
  params: WireQueryParams
}

export interface PreflightResultPayload {
  count: number
  analysisStale: boolean
}
