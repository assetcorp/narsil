import type { DatasetLoadProgress, LoadDatasetRequest } from './types'

export type BackendEventType = 'progress' | 'ready' | 'error'

export type BackendEventPayload = {
  progress: DatasetLoadProgress
  ready: { indexName: string }
  error: { message: string }
}

export type BackendEventHandler<T extends BackendEventType> = (payload: BackendEventPayload[T]) => void

export interface QueryRequest {
  indexName: string
  term?: string
  fields?: string[]
  filters?: Record<string, unknown>
  boost?: Record<string, number>
  sort?: Record<string, 'asc' | 'desc'>
  limit?: number
  offset?: number
  searchAfter?: string
  facets?: Record<string, unknown>
  tolerance?: number
  termMatch?: 'all' | 'any' | number
  exact?: boolean
  minScore?: number
  group?: { fields: string[]; maxPerGroup?: number }
  highlight?: { fields: string[]; preTag?: string; postTag?: string }
  includeScoreComponents?: boolean
}

export interface SuggestRequest {
  indexName: string
  prefix: string
  limit?: number
}

export interface QueryHit {
  id: string
  score: number
  document: Record<string, unknown>
  scoreComponents?: {
    termFrequencies: Record<string, number>
    fieldLengths: Record<string, number>
    idf: Record<string, number>
  }
  highlights?: Record<string, { snippet: string; positions: Array<{ start: number; end: number }> }>
}

export interface QueryResponse {
  hits: QueryHit[]
  count: number
  elapsed: number
  cursor?: string
  facets?: Record<string, { values: Record<string, number>; count: number }>
  groups?: Array<{ values: Record<string, unknown>; hits: QueryHit[] }>
}

export interface SuggestResponse {
  terms: Array<{ term: string; documentFrequency: number }>
  elapsed: number
}

export interface IndexStats {
  documentCount: number
  partitionCount: number
  memoryBytes: number
  indexSizeBytes: number
  language: string
  schema: Record<string, unknown>
}

export interface PartitionStats {
  partitionId: number
  documentCount: number
  estimatedMemoryBytes: number
  vectorFieldCount: number
  isHnswPromoted: boolean
}

export interface MemoryStatsResponse {
  totalBytes: number
  workers: Array<{
    workerId: number
    heapUsed: number
    heapTotal: number
    external: number
  }>
}

export interface IndexListEntry {
  name: string
  documentCount: number
  partitionCount: number
  language: string
}

export interface NarsilBackend {
  loadDataset(request: LoadDatasetRequest): Promise<void>
  query(request: QueryRequest): Promise<QueryResponse>
  batchQuery?(requests: QueryRequest[], onResult: (index: number, response: QueryResponse) => void): Promise<void>
  suggest(request: SuggestRequest): Promise<SuggestResponse>
  getStats(indexName: string): Promise<IndexStats>
  getPartitionStats(indexName: string): Promise<PartitionStats[]>
  getMemoryStats(): Promise<MemoryStatsResponse>
  listIndexes(): Promise<IndexListEntry[]>
  deleteIndex(indexName: string): Promise<void>
  subscribe<T extends BackendEventType>(event: T, handler: BackendEventHandler<T>): void
  unsubscribe<T extends BackendEventType>(event: T, handler: BackendEventHandler<T>): void
}
