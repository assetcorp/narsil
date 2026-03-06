import type { FilterExpression } from './filters'
import type { ScoringMode } from './schema'

export type SearchMode = 'fulltext' | 'vector' | 'hybrid'
export type TermMatchPolicy = 'all' | 'any' | number

export interface QueryParams {
  term?: string
  fields?: string[]
  filters?: FilterExpression
  boost?: Record<string, number>
  scoring?: ScoringMode
  minScore?: number
  termMatch?: TermMatchPolicy
  tolerance?: number
  prefixLength?: number
  exact?: boolean
  facets?: FacetConfig
  sort?: Record<string, 'asc' | 'desc'>
  group?: GroupConfig
  limit?: number
  offset?: number
  searchAfter?: string
  highlight?: HighlightConfig
  pinned?: Array<{ docId: string; position: number }>
  mode?: SearchMode
  vector?: VectorQueryConfig
  hybrid?: HybridConfig
}

export interface VectorQueryConfig {
  field: string
  value: number[]
  similarity?: number
  metric?: 'cosine' | 'dotProduct' | 'euclidean'
  efSearch?: number
}

export interface HybridConfig {
  alpha?: number
}

export interface FacetConfig {
  [field: string]: {
    limit?: number
    sort?: 'asc' | 'desc'
    ranges?: Array<{ from: number; to: number }>
  }
}

export interface GroupConfig {
  fields: string[]
  maxPerGroup?: number
  reduce?: GroupReducer
}

export type GroupReducer = {
  reducer: (accumulator: unknown, doc: Record<string, unknown>, score: number) => unknown
  initialValue: () => unknown
}

export interface HighlightConfig {
  fields: string[]
  preTag?: string
  postTag?: string
  maxSnippetLength?: number
}
