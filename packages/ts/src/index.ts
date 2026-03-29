export type { ErrorCode } from './errors'
export { ErrorCodes, NarsilError } from './errors'
export { getLanguage, registerLanguage } from './languages/registry'
export type { Narsil } from './narsil'
export { createNarsil } from './narsil'

export { isSimdAvailable } from './vector/simd'
export const VERSION = '0.1.0'

export type {
  EmbeddingAdapter,
  InvalidationAdapter,
  InvalidationEvent,
  PartitionStatistics,
  PersistenceAdapter,
} from './types/adapters'
export type { FlushConfig, NarsilConfig, WorkerConfig } from './types/config'
export type { NarsilEventMap } from './types/events'
export type {
  ArrayFilter,
  ComparisonFilter,
  FilterExpression,
  GeoPolygonFilter,
  GeoRadiusFilter,
  PresenceFilter,
  StringFilter,
} from './types/filters'
export type { LanguageModule } from './types/language'
export type {
  IndexContext,
  InsertContext,
  NarsilPlugin,
  PartitionContext,
  RemoveContext,
  SearchContext,
  UpdateContext,
  WorkerContext,
} from './types/plugins'
export type {
  BatchResult,
  FacetResult,
  GroupResult,
  HighlightMatch,
  Hit,
  IndexInfo,
  IndexStats,
  MemoryStats,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  ScoreComponents,
  SuggestResult,
} from './types/results'
export type {
  AnyDocument,
  BM25Params,
  CustomTokenizer,
  EmbeddingFieldConfig,
  FieldType,
  IndexConfig,
  InsertOptions,
  PartitionConfig,
  SchemaDefinition,
  ScoringMode,
} from './types/schema'
export type {
  FacetConfig,
  GroupConfig,
  GroupReducer,
  HighlightConfig,
  HybridConfig,
  QueryParams,
  SearchMode,
  SuggestParams,
  TermMatchPolicy,
  VectorQueryConfig,
} from './types/search'
