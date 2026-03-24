import type { DatasetId } from './manifest'

export type TabId = 'datasets' | 'search' | 'relevance' | 'benchmark' | 'inspector'

export type TabStatus = 'locked' | 'ready'

export interface LoadedIndex {
  name: string
  datasetId: DatasetId
  documentCount: number
  language: string
}

export type DatasetLoadPhase = 'fetching' | 'indexing' | 'complete' | 'error'

export interface DatasetLoadProgress {
  datasetId: DatasetId
  phase: DatasetLoadPhase
  totalBytes?: number
  loadedBytes?: number
  totalDocs?: number
  indexedDocs?: number
  error?: string
}

export interface LoadTmdbRequest {
  datasetId: 'tmdb'
  tier: string
}

export interface LoadWikipediaRequest {
  datasetId: 'wikipedia'
  languages: string[]
}

export interface LoadCranfieldRequest {
  datasetId: 'cranfield'
}

export interface LoadCustomRequest {
  datasetId: 'custom'
  documents: Record<string, unknown>[]
  schema: Record<string, string>
  indexName: string
  language?: string
}

export type LoadDatasetRequest = LoadTmdbRequest | LoadWikipediaRequest | LoadCranfieldRequest | LoadCustomRequest

export interface AppState {
  indexes: LoadedIndex[]
  activeIndexName: string | null
  loadingDatasets: Map<DatasetId, DatasetLoadProgress>
  cranfieldLoaded: boolean
  restoring: boolean
  tabStatus: Record<TabId, TabStatus>
}

export type AppAction =
  | { type: 'SET_LOADING'; payload: DatasetLoadProgress }
  | { type: 'INDEX_READY'; payload: LoadedIndex }
  | { type: 'REMOVE_INDEX'; payload: string }
  | { type: 'SET_ACTIVE_INDEX'; payload: string }
  | { type: 'CRANFIELD_LOADED' }
  | { type: 'LOADING_ERROR'; payload: { datasetId: DatasetId; error: string } }
  | { type: 'SET_RESTORING'; payload: boolean }
