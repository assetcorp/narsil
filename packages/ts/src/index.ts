export {
  getStopWords,
  getTokenizer,
  hasStopWords,
  hasTokenizer,
  registerStopWords,
  registerTokenizer,
} from './analysis/registry'
export {
  clearNormalizationCache,
  configureNormalizationCache,
  getNormalizationCacheSize,
  resetNormalizationCache,
} from './core/tokenizer'
export type { ClientErrorCode, ErrorCode, NarsilErrorCode, ServerErrorCode } from './errors'
export { ClientErrorCodes, ErrorCodes, NarsilError, ServerErrorCodes } from './errors'
export { getLanguage, registerLanguage } from './languages/registry'
export type { Narsil } from './narsil'
export { createNarsil } from './narsil'
export type {
  EmbeddingAdapter,
  InvalidationAdapter,
  InvalidationEvent,
  PartitionStatistics,
  PersistenceAdapter,
} from './types/adapters'
export type {
  AnalysisConfig,
  DurabilityConfig,
  IndexLifecycleConfig,
  MainCopyQueries,
  NarsilConfig,
  StaleAnalysis,
  WorkerConfig,
} from './types/config'
export type { NarsilEventMap } from './types/events'
export type {
  ArrayFilter,
  ComparisonFilter,
  FieldFilter,
  FilterExpression,
  GeoFilter,
  GeoPolygonFilter,
  GeoRadiusFilter,
  PresenceFilter,
  StringFilter,
} from './types/filters'
export type { LanguageModule, TokenizerConfig } from './types/language'
export type { IndexLifecycleOperations } from './types/lifecycle'
export type { MemoryStats, ProcessMemoryReport, WorkerCopyReport } from './types/memory'
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
  ListedDocument,
  ListResult,
  PartitionStatsResult,
  PreflightResult,
  QueryCoverage,
  QueryResult,
  ScoreComponents,
  SuggestResult,
  VectorMaintenanceResult,
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
  StopWordOverride,
  VectorIndexConfig,
  VectorQuantizationMode,
} from './types/schema'
export type {
  DocumentProjection,
  FacetConfig,
  GroupConfig,
  GroupReducer,
  HighlightConfig,
  HybridConfig,
  ListParams,
  QueryParams,
  SearchMode,
  SortField,
  SortSpec,
  SuggestParams,
  TermMatchPolicy,
  VectorQueryConfig,
} from './types/search'
export { isSimdAvailable } from './vector/simd'
/**
 * Engine version written into the engine-version bytes of every `.nrsl` file,
 * for diagnostics.
 *
 * It records which engine produced a file and carries no relation to the
 * published package version, so read it when inspecting a file rather than
 * when checking what you installed. Change it by hand and on purpose.
 *
 * @public
 */
export const VERSION = '0.1.0'
