import type { IndexInfo } from '@delali/narsil'
import type { DatasetId } from './manifest'

export type TabId = 'datasets' | 'search' | 'ask' | 'relevance' | 'benchmark' | 'inspector' | 'documents'

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

export interface LoadScifactRequest {
  datasetId: 'scifact'
}

export interface LoadCustomRequest {
  datasetId: 'custom'
  documents: Record<string, unknown>[]
  schema: Record<string, string>
  indexName: string
  language?: string
}

export type LoadDatasetRequest = LoadTmdbRequest | LoadWikipediaRequest | LoadScifactRequest | LoadCustomRequest

export function inferDatasetId(indexName: string): DatasetId {
  if (indexName.startsWith('tmdb-')) return 'tmdb'
  if (indexName.startsWith('wikipedia-')) return 'wikipedia'
  if (indexName === 'scifact') return 'scifact'
  return 'custom'
}

export function toLoadedIndexes(indexes: readonly IndexInfo[]): LoadedIndex[] {
  return indexes.map(index => ({
    name: index.name,
    datasetId: inferDatasetId(index.name),
    documentCount: index.documentCount,
    language: index.language,
  }))
}

export function computeTabStatus(indexes: readonly LoadedIndex[]): Record<TabId, TabStatus> {
  const hasAnyIndex = indexes.length > 0
  const hasAnyDocs = indexes.some(index => index.documentCount > 0)

  return {
    datasets: 'ready',
    search: hasAnyDocs ? 'ready' : 'locked',
    ask: hasAnyDocs ? 'ready' : 'locked',
    relevance: hasAnyDocs ? 'ready' : 'locked',
    benchmark: hasAnyDocs ? 'ready' : 'locked',
    inspector: hasAnyIndex ? 'ready' : 'locked',
    documents: hasAnyIndex ? 'ready' : 'locked',
  }
}
