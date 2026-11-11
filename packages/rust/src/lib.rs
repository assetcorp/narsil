#![doc = include_str!("../README.md")]

mod adapters;
mod analysis;
mod config;
#[doc(hidden)]
pub mod conformance;
mod durability;
mod engine;
mod error;
mod ffi;
mod filters;
mod format;
mod geo;
mod index;
mod keyword;
mod native;
mod ordering;
mod pattern;
mod pins;
mod schema;
mod search;
mod synonyms;
mod util;
mod value;
mod vector;

pub use adapters::{AdapterError, EmbeddingAdapter, EmbeddingPurpose, RerankAdapter};
pub use analysis::{Language, StopWordFunction, StopWords, Token, Tokenizer};
pub use config::{
    AdapterSetting, Bm25FieldParams, Bm25Params, EmbeddingConfig, HnswSettings, IndexConfig,
    Metric, PartitionConfig, Quantization, ScoringMode, StopWordsSetting, Storage, SynonymRule,
    TokenizerSetting, VectorPromotion,
};
pub use durability::persistence::{FilesystemPersistence, MemoryPersistence, PersistenceAdapter};
pub use engine::{
    AnalysisChange, AnalysisSetting, BatchFailure, BatchResult, DocumentImportResult,
    DocumentProjection, DurabilityConfig, DurabilityMode, DurabilityTier, EarlierLayout,
    FacetResult, FacetSpec, GroupConfig, GroupReduce, GroupReducer, GroupResult, HighlightConfig,
    HighlightMatch, HighlightPosition, Hit, HybridConfig, HybridStrategy, ImportRefusal, IndexInfo,
    IndexStats, ListParams, ListResult, ListedDocument, ListenerId, MemoryStats, Narsil,
    NarsilConfig, NarsilEvent, NarsilEventKind, PartitionStats, Pin, Plugin, PreflightResult,
    QueryCoverage, QueryParams, QueryResult, RerankConfig, ScoreComponents, SearchMode,
    SortDirection, SortField, SortMode, SuggestParams, SuggestResult, SuggestedTerm, SyncSetting,
    SyncStatus, TermMatch, VectorMaintenanceStatus, VectorQuery, WorkStatus,
};
pub use engine::{
    AnalysisConfig, AnalysisRebuildMode, IdGenerator, IndexLifecycleConfig, IndexResidencyState,
    MemoryConfig, StaleAnalysis, StaleAnalysisListener, StaleRebuild,
};
pub use engine::{
    Change, ChangeFeed, ChangeFeedStop, ChangeGroup, ChangePosition, ChangeType, ChangesEvent,
    ChangesRequest, ChangesSetting, ChangesStatus, ChangesSubscribed, ResyncReason,
};
pub use engine::{MainCopyQueries, WorkerConfig, WriteOptions};
pub use engine::{
    ManualQuerySuggestion, QuerySuggestionPreviewEntry, QuerySuggestions, QuerySuggestionsBuild,
    QuerySuggestionsBuildPhase, QuerySuggestionsBuildStatus, QuerySuggestionsBuildTrigger,
    QuerySuggestionsConfig, QuerySuggestionsPreview, QuerySuggestionsSetting,
    QuerySuggestionsSource, QuerySuggestionsStatus, QuerySuggestionsWarningReason,
    RecordQueryOutcome, RecordQueryResult, RecordedQuery, SnapshotOptions,
};
pub use error::{ErrorCode, NarsilError, Result};
pub use filters::{DistanceUnit, FieldTests, Filter, GeoPolygon, GeoRadius, Scalar, Tolerance};
pub use value::{Map, Timestamp, Value, parse_json, write_json};
