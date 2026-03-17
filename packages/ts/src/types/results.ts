import type { NarsilError } from '../errors'
import type { AnyDocument, SchemaDefinition } from './schema'

export interface QueryResult<T = AnyDocument> {
  hits: Array<Hit<T>>
  count: number
  elapsed: number
  cursor?: string
  facets?: Record<string, FacetResult>
  groups?: GroupResult[]
}

export interface Hit<T = AnyDocument> {
  id: string
  score: number
  document: T
  scoreComponents?: ScoreComponents
  highlights?: Record<string, HighlightMatch>
}

export interface ScoreComponents {
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
  idf: Record<string, number>
}

export interface HighlightMatch {
  snippet: string
  positions: Array<{ start: number; end: number }>
}

export interface FacetResult {
  values: Record<string, number>
  count: number
}

export interface GroupResult {
  values: Record<string, unknown>
  hits: Array<Hit>
}

export interface PreflightResult {
  count: number
  elapsed: number
}

export interface BatchResult {
  succeeded: string[]
  failed: Array<{ docId: string; error: NarsilError }>
}

export interface IndexStats {
  documentCount: number
  partitionCount: number
  memoryBytes: number
  indexSizeBytes: number
  language: string
  schema: SchemaDefinition
}

export interface IndexInfo {
  name: string
  documentCount: number
  partitionCount: number
  language: string
}

export interface PartitionStatsResult {
  partitionId: number
  documentCount: number
  estimatedMemoryBytes: number
  vectorFieldCount: number
  isHnswPromoted: boolean
}

export interface MemoryStats {
  totalBytes: number
  workers: Array<{
    workerId: number
    heapUsed: number
    heapTotal: number
    external: number
  }>
}
