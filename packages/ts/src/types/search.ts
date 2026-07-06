import type { FilterExpression } from './filters'
import type { AnyDocument, ScoringMode } from './schema'

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
  /**
   * Treat the last query token as an unfinished word so it also matches
   * indexed terms that complete it ("secur" matches "security"). Earlier
   * tokens must match fully; `tolerance` keeps applying to them but not to
   * the prefix token. Completions score against a shared document frequency
   * and are demoted below full-word matches. Ignored when `exact` is true.
   * Off by default.
   */
  prefix?: boolean
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
  includeScoreComponents?: boolean
}

/**
 * Vector-search inputs passed under `QueryParams.vector`.
 *
 * Supply either a raw `value` array or a `text` string for auto-embedding;
 * passing both throws `EMBEDDING_CONFIG_INVALID`. Result count is governed
 * by the outer query's `limit`, not by any field on this object.
 */
export interface VectorQueryConfig {
  /**
   * Name of the schema field that holds the vector to compare against.
   * Must reference a field declared as `vector[N]` in the index schema.
   */
  field: string
  /**
   * Raw query vector. Length must match the indexed field's dimension or
   * the search rejects the request with `VECTOR_DIMENSION_MISMATCH`.
   */
  value?: number[]
  /**
   * Text to embed at query time using the index or instance embedding
   * adapter. Mutually exclusive with `value`; requires a configured adapter.
   */
  text?: string
  /**
   * Score floor applied during ranking. Hits scoring below this value
   * are dropped before `limit` is enforced, so the returned hit count
   * can be smaller than `limit` even when more documents exist. The
   * floor is interpreted in score space for every metric; for
   * `euclidean`, distance is mapped to a similarity score of
   * `1 / (1 + distance)` first. Defaults to no floor.
   */
  similarity?: number
  /**
   * Similarity metric used for ranking. Defaults to `cosine`. Choose
   * `dotProduct` for raw inner-product scoring on already-normalised
   * vectors and `euclidean` for distance-based ordering.
   */
  metric?: 'cosine' | 'dotProduct' | 'euclidean'
  /**
   * HNSW exploration factor for approximate search. Higher values raise
   * recall at the cost of latency. Ignored while the field is still
   * served by the brute-force backend. Defaults to the engine's built-in
   * value when omitted.
   */
  efSearch?: number
}

export interface HybridConfig {
  strategy?: 'rrf' | 'linear'
  k?: number
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
  reducer: (accumulator: unknown, doc: AnyDocument, score: number) => unknown
  initialValue: () => unknown
}

export interface HighlightConfig {
  fields: string[]
  preTag?: string
  postTag?: string
  maxSnippetLength?: number
}

export interface SuggestParams {
  prefix: string
  limit?: number
}
