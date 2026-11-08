export {
  getStopWords,
  getTokenizer,
  hasStopWords,
  hasTokenizer,
  registerStopWords,
  registerTokenizer,
} from './analysis/registry'
export { registerPartialWordSearch } from './core/partition/partial-words/registry'
export { registerPatternSearch } from './core/pattern-index/registry'
export { registerSynonyms } from './core/synonyms/registry'
export {
  clearNormalizationCache,
  configureNormalizationCache,
  getNormalizationCacheSize,
  resetNormalizationCache,
} from './core/tokenizer'
export type { ClientErrorCode, ErrorCode, NarsilErrorCode, ServerErrorCode } from './errors'
export { ClientErrorCodes, ErrorCodes, isNarsilError, NarsilError, ServerErrorCodes } from './errors'
export { getLanguage, registerLanguage } from './languages/registry'
export type { ByteSource, Narsil } from './narsil'
export { createNarsil } from './narsil'
export type {
  ReactNativeDirectoryEntry,
  ReactNativeFileStatus,
  ReactNativeFiles,
  ReactNativeHost,
} from './runtime/react-native-host'
export { isSimdAvailable } from './runtime/simd-support'
export type { AdapterRegistrationOperations } from './types/adapter-registration'
export type {
  EmbeddingAdapter,
  InvalidationAdapter,
  InvalidationEvent,
  PartitionStatistics,
  PersistenceAdapter,
  RerankAdapter,
} from './types/adapters'
export type { AnalysisChange, AnalysisOperations } from './types/analysis-operations'
export type { BM25Operations } from './types/bm25-operations'
export type {
  AnalysisConfig,
  DurabilityConfig,
  IndexLifecycleConfig,
  MainCopyQueries,
  MemoryConfig,
  NarsilConfig,
  QuerySuggestionsConfig,
  StaleAnalysis,
  WorkerConfig,
} from './types/config'
export type { SnapshotOptions } from './types/engine'
export type { NarsilEventHandlers, NarsilEventMap } from './types/events'
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
export type { HeldCheckpointReport, MemoryStats, ProcessMemoryReport, WorkerCopyReport } from './types/memory'
export type { PartialWordSearch } from './types/partial-words'
export type { PatternSearch } from './types/pattern'
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
export type { QuerySuggestionsBuildEvent, QuerySuggestionsWarningEvent } from './types/query-suggestions'
export type {
  BatchResult,
  DocumentImportResult,
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
  BM25FieldParams,
  BM25Params,
  CustomTokenizer,
  EmbeddingFieldConfig,
  FieldOptionChain,
  FieldType,
  IndexConfig,
  InsertOptions,
  PartitionConfig,
  SchemaDefinition,
  ScoringMode,
  StopWordOverride,
  TextFieldOption,
  VectorIndexConfig,
  VectorQuantizationMode,
  VectorStorageMode,
  WriteOptions,
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
  RerankConfig,
  SearchMode,
  SortField,
  SortSpec,
  SuggestParams,
  TermMatchPolicy,
  VectorQueryConfig,
} from './types/search'
export type { SyncOperations, SyncSetting, SyncStatus } from './types/sync'
export type { SynonymOperations } from './types/synonym-operations'
export type { OneWaySynonymRule, SynonymRule, SynonymSearch, TwoWaySynonymRule } from './types/synonyms'
export type { VectorMaintenanceOperations } from './types/vector-maintenance-operations'
export type { DocumentWriteOperations } from './types/writes'
export type { NativeAnalysisCore, NativeStopWordSetHandle } from './vector/native/analysis-types'
export type { NativeKeywordCore } from './vector/native/keyword-types'
export type {
  NativeConnectResult,
  NativeCore,
  NativeGraphHandle,
  NativeGraphMemory,
  NativeScoreResult,
  NativeSearchResult,
  NativeStoreHandle,
  NativeStoreMemory,
} from './vector/native/types'
export type { NativeExpansionCore, NativeExpansionSegment } from './vector/native/types/expansion'
export type { NativeFacetCore } from './vector/native/types/facets'
export type {
  NativeFieldMergeCore,
  NativeFieldMergeRegion,
  NativeFieldMergeSource,
} from './vector/native/types/field-merge'
export type { NativeFilterCore, NativeFilterRegion } from './vector/native/types/filters'
export type {
  NativeFrozenRemovalIndex,
  NativeFrozenSegment,
  NativeFrozenSegmentCore,
  NativeFrozenSegmentState,
  NativeFrozenStrings,
} from './vector/native/types/frozen-segments'
export type { NativeGroupCore } from './vector/native/types/groups'
export type { NativeHighlightCore, NativeHighlightQuery } from './vector/native/types/highlight'
export type {
  NativePageCache,
  NativePagedCore,
  NativePagedFileHandle,
  NativePagedGraphPart,
  NativePagedVectorField,
  NativePagedVectorFile,
  NativePagedVectorRequest,
  NativePageSection,
} from './vector/native/types/paged'
export type {
  NativeFrozenRuns,
  NativePartialExpansionCore,
  NativePartialRequest,
  NativePartialSource,
} from './vector/native/types/partial-expansion'
export type { NativePatternCore } from './vector/native/types/pattern'
export type { NativePhraseCore, NativePhrasePostings, NativePhraseRequest } from './vector/native/types/phrases'
export type { NativeResultCore } from './vector/native/types/results'
export type {
  NativeKeywordMergeInput,
  NativeKeywordMergeOutput,
  NativePostingMergeOutput,
  NativeSegmentMergeCore,
} from './vector/native/types/segment-merge'
export type {
  NativeFieldTokens,
  NativeGrowingSegment,
  NativePositionPool,
  NativePostingPool,
  NativeRunTable,
  NativeSegmentCore,
  NativeSliceAllocator,
  NativeSpellingTable,
  NativeSurfaceTable,
  NativeTermColumns,
} from './vector/native/types/segments'
export type { NativeSortColumn, NativeSortCore, NativeSortValues } from './vector/native/types/sort'
export type { NativeStoredValues } from './vector/native/types/stored-values'
export type { NativeSynonymCore, NativeSynonymTable } from './vector/native/types/synonyms'
export type { NativeTermCore, NativeTermDictionary, NativeTermTable } from './vector/native/types/terms'
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
