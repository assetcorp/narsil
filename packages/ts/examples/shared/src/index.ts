export type {
  BackendEventHandler,
  BackendEventPayload,
  BackendEventType,
  HybridQueryRequest,
  IndexListEntry,
  IndexStats,
  MemoryStatsResponse,
  NarsilBackend,
  PartitionStats,
  QueryHit,
  QueryRequest,
  QueryResponse,
  SearchMode,
  SuggestRequest,
  SuggestResponse,
  VectorQueryRequest,
} from './backend'
export type { CommandPaletteControls } from './context'
export {
  AppDispatchContext,
  AppStateContext,
  BackendContext,
  CommandPaletteContext,
  useAppDispatch,
  useAppState,
  useBackend,
  useCommandPalette,
} from './context'
export { cn } from './lib/utils'
export type {
  CustomDataset,
  Dataset,
  DatasetId,
  DatasetTier,
  ScifactDataset,
  TmdbDataset,
  WikiLanguage,
  WikipediaDataset,
} from './manifest'
export {
  COMMITTED_SIZE_THRESHOLD,
  custom,
  datasets,
  scifact,
  tmdb,
  wikipedia,
} from './manifest'
export type { SchemaDefinition } from './schemas'
export { scifactSchema, tmdbSchema, wikipediaSchema } from './schemas'
export type { BM25Config, RecomputedHit } from './scoring'
export { computeFieldAverages, DEFAULT_BM25_CONFIG, recomputeScores } from './scoring'
export { appReducer, createInitialState } from './state'
export type {
  AppAction,
  AppState,
  DatasetLoadPhase,
  DatasetLoadProgress,
  LoadCustomRequest,
  LoadDatasetRequest,
  LoadedIndex,
  LoadScifactRequest,
  LoadTmdbRequest,
  LoadWikipediaRequest,
  TabId,
  TabStatus,
} from './types'
