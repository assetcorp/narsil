import type { DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared/types'

export interface WorkerRequest {
  requestId: string
  type: 'loadDataset' | 'query' | 'suggest' | 'getStats' | 'getPartitionStats' | 'getMemoryStats' | 'listIndexes'
  payload: unknown
}

export interface LoadDatasetPayload {
  request: LoadDatasetRequest
}

export interface QueryPayload {
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

export interface SuggestPayload {
  indexName: string
  prefix: string
  limit?: number
}

export interface IndexNamePayload {
  indexName: string
}

export interface WorkerResponse {
  type: 'response'
  requestId: string
  result?: unknown
  error?: string
}

export interface WorkerProgressEvent {
  type: 'progress'
  payload: DatasetLoadProgress
}

export type WorkerOutbound = WorkerResponse | WorkerProgressEvent
