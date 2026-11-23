#![doc = include_str!("../README.md")]

mod adapters;
mod analysis;
mod config;
#[doc(hidden)]
pub mod conformance;
#[doc(hidden)]
pub mod coordination;
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
#[doc(hidden)]
pub mod held_analysis {
    pub use crate::engine::{HeldAnalysisChanges, PendingAnalysisChange};
}
#[doc(hidden)]
pub mod replication {
    pub use crate::engine::replication::{
        AppliedRun, BackupListedFile, BackupPartitionFiles, CopyChangesState, CopyEpochStates,
        CopyPosition, CopySyncState, EntryOperation, HeldTerm, NodeMemoryReading, PartitionBackup,
        PartitionCopies, PrimaryLimits, PrimaryRefusal, PrimaryRun, PrimaryWrite, PrimaryWritten,
        PriorDocument, ReplicatedEntry, WriteRecord, read_process_memory,
    };
    pub use crate::format::backup_manifest::{
        BackupConstraints, BackupManifest, BackupPartition, ListedFile, StoredFile,
        backup_partition, decode_backup_manifest, encode_backup_manifest, stored_file,
    };
    pub use crate::format::backup_manifest_write::{backup_partition_wire, stored_file_wire};
}
#[doc(hidden)]
pub mod partitions {
    pub use crate::engine::{
        PartitionQuery, PartitionStatistics, StatsExpansion, SuppliedStatistics,
    };
    pub use crate::ordering::document_sort_values;
}
#[doc(hidden)]
pub mod suggestions_host {
    pub use crate::engine::query_suggestions::build_record::BuildRecord;
    pub use crate::engine::query_suggestions::counts_stream::{
        HistoryStream, HistoryStreamReader, StreamedHistoryFile,
    };
    pub use crate::engine::query_suggestions::host::{
        HistoryFilesRef, IndexView, RemoteFile, SuggestionsHost,
    };
    pub use crate::engine::query_suggestions::service::{
        RestoredHistoryWriter, SuggestionsService,
    };
    pub use crate::engine::query_suggestions::stored_state::SuggestionState;
}
mod schema;
mod search;
mod synonyms;
mod util;
mod value;
mod vector;

pub use adapters::{AdapterError, EmbeddingAdapter, EmbeddingPurpose, RerankAdapter};
pub use analysis::{Language, StopWordFunction, StopWords, Token, TokenSource, Tokenizer};
pub use config::{
    AdapterSetting, Bm25FieldParams, Bm25Params, EmbeddingConfig, HnswSettings, IndexConfig,
    Metric, PartitionConfig, Quantization, ScoringMode, StopWordsSetting, Storage, SynonymRule,
    TokenizerSetting, VectorPromotion, index_config_from_stored_settings, validate_index_name,
};
pub use durability::persistence::{FilesystemPersistence, MemoryPersistence, PersistenceAdapter};
#[doc(hidden)]
pub use durability::platform::rename_replacing;
pub use engine::{
    AnalysisChange, AnalysisSetting, BatchFailure, BatchResult, DocumentImportResult,
    DocumentProjection, DurabilityConfig, DurabilityMode, DurabilityTier, EarlierLayout,
    FacetResult, FacetSpec, FeedChange, GroupConfig, GroupReduce, GroupReducer, GroupResult,
    HighlightConfig, HighlightMatch, HighlightPosition, Hit, HybridConfig, HybridStrategy,
    ImportRefusal, IndexInfo, IndexStats, ListParams, ListResult, ListedDocument, ListenerId,
    MemoryStats, Narsil, NarsilConfig, NarsilEvent, NarsilEventKind, ParseKind, ParseShortfall,
    PartitionStats, Pin, Plugin, PreflightResult, QueryCoverage, QueryParams, QueryResult,
    RerankConfig, ScoreComponents, SearchMode, SortDirection, SortField, SortMode, SuggestParams,
    SuggestResult, SuggestedTerm, SyncSetting, SyncStatus, TermMatch, VectorMaintenanceStatus,
    VectorQuery, WorkStatus,
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
pub use engine::{SyncBounds, SyncCursor, SyncEntry, SyncFeedState, SyncRead, SyncSnapshot};
pub use error::{ErrorCode, NarsilError, Result};
pub use filters::{DistanceUnit, FieldTests, Filter, GeoPolygon, GeoRadius, Scalar, Tolerance};
pub use synonyms::wire::synonym_rules_from_json;
pub use value::{
    Map, Timestamp, Value, decode_msgpack, encode_msgpack, json_nests_too_deep, parse_json,
    parse_plain_json, write_json, write_plain_json, write_plain_json_into,
};
