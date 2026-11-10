pub(crate) mod adapter_registry;
mod analysis_change;
pub(crate) mod changes;
mod clear;
mod constants;
pub(crate) mod document_writes;
mod documents;
pub(crate) mod durable;
mod engine_config;
pub(crate) mod events;
mod export;
mod hooked;
mod ids;
pub(crate) mod index;
pub(crate) mod index_lifecycle;
pub(crate) mod layout;
mod lifecycle;
mod maintenance;
pub(crate) mod memory;
mod name_turns;
pub(crate) mod plugins;
mod portability;
pub(crate) mod query;
pub(crate) mod query_suggestions;
mod reads;
mod rebalance;
mod registration;
mod rerank_settings;
mod restore;
mod segments;
mod settings;
mod stale_review;
mod stats;
mod suggest;
pub(crate) mod sync;
mod synonyms;
pub(crate) mod vectors;
mod wait;
pub(crate) mod workers;
pub(crate) mod writes;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak};

use crate::analysis::AnalysisRegistry;
use crate::config::IndexConfig;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::pattern::constants::DEFAULT_PATTERN_WORK_CAP;
use adapter_registry::AdapterRegistry;
pub use changes::analysis::{AnalysisChange, AnalysisSetting};
use durable::Durable;
pub use durable::config::{DurabilityConfig, DurabilityMode, DurabilityTier, NarsilConfig};
use durable::config::{ResolvedTier, resolve_pattern_work_cap, resolve_tier};
pub use engine_config::{
    AnalysisConfig, AnalysisRebuildMode, IdGenerator, IndexLifecycleConfig, MemoryConfig,
    StaleAnalysis, StaleAnalysisListener,
};
use engine_config::{EngineSettings, engine_settings};
pub use events::{EarlierLayout, ListenerId, NarsilEvent, NarsilEventKind, WorkStatus};
pub use export::{DocumentImportResult, ImportRefusal};
use index::IndexState;
pub use index_lifecycle::IndexResidencyState;
use name_turns::NameTurns;
pub use plugins::Plugin;
pub use portability::SnapshotOptions;
pub use query::listing::{ListParams, ListResult, ListedDocument};
pub use query::params::{
    DocumentProjection, FacetSpec, GroupConfig, GroupReduce, GroupReducer, HighlightConfig,
    HybridConfig, HybridStrategy, Pin, QueryParams, RerankConfig, SearchMode, SortDirection,
    SortField, SortMode, TermMatch, VectorQuery,
};
pub use query::preflight::PreflightResult;
pub use query::results::{
    FacetResult, GroupResult, HighlightMatch, HighlightPosition, Hit, QueryCoverage, QueryResult,
    ScoreComponents,
};
pub use query_suggestions::{
    ManualQuerySuggestion, QuerySuggestionPreviewEntry, QuerySuggestions, QuerySuggestionsBuild,
    QuerySuggestionsBuildPhase, QuerySuggestionsBuildStatus, QuerySuggestionsBuildTrigger,
    QuerySuggestionsConfig, QuerySuggestionsPreview, QuerySuggestionsSetting,
    QuerySuggestionsSource, QuerySuggestionsStatus, QuerySuggestionsWarningReason,
    RecordQueryOutcome, RecordQueryResult, RecordedQuery,
};
pub use reads::IndexInfo;
pub use stale_review::StaleRebuild;
pub use stats::{IndexStats, MemoryStats, PartitionStats};
pub use suggest::{SuggestParams, SuggestResult, SuggestedTerm};
pub use sync::{SyncSetting, SyncStatus};
pub use vectors::VectorMaintenanceStatus;
pub use wait::WriteOptions;
pub use workers::{MainCopyQueries, WorkerConfig};
pub use writes::{BatchFailure, BatchResult};

pub(crate) struct EngineInner {
    indexes: RwLock<BTreeMap<String, Arc<IndexState>>>,
    pub(crate) names: NameTurns,
    pub(crate) analysis: AnalysisRegistry,
    pub(crate) adapters: Arc<AdapterRegistry>,
    pub(crate) durable: Option<Durable>,
    pub(crate) events: events::EventBus,
    pub(crate) plugins: plugins::PluginRegistry,
    pub(crate) pattern_work_cap: i64,
    pub(crate) settings: EngineSettings,
    pub(crate) lifecycle: index_lifecycle::IndexLifecycle,
    pub(crate) memory: memory::MemoryGuard,
    pub(crate) rebuild_queue: stale_review::RebuildQueue,
    pub(crate) self_ref: Weak<EngineInner>,
    pub(crate) suggestions: query_suggestions::runtime::SuggestionsRuntime,
    shut_down: AtomicBool,
}

impl EngineInner {
    pub(crate) fn guard_shutdown(&self) -> Result<()> {
        if self.shut_down.load(Ordering::Acquire) {
            return Err(NarsilError::new(
                ErrorCode::INSTANCE_SHUT_DOWN,
                "This Narsil instance has been shut down",
            ));
        }
        Ok(())
    }

    pub(crate) fn durable(&self) -> bool {
        self.durable.is_some()
    }

    pub(crate) fn filesystem_durability(&self) -> bool {
        self.durable.as_ref().is_some_and(Durable::holds_directory)
    }

    pub(crate) fn index_list(&self) -> Vec<Arc<IndexState>> {
        self.indexes().values().cloned().collect()
    }

    fn after_write(&self, index: &IndexState) {
        if let Some(durable) = &self.durable {
            durable.after_write(index);
        }
    }

    fn indexes(&self) -> RwLockReadGuard<'_, BTreeMap<String, Arc<IndexState>>> {
        self.indexes
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn indexes_mut(&self) -> RwLockWriteGuard<'_, BTreeMap<String, Arc<IndexState>>> {
        self.indexes
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn index(&self, name: &str) -> Result<Arc<IndexState>> {
        self.indexes().get(name).cloned().ok_or_else(|| {
            NarsilError::new(
                ErrorCode::INDEX_NOT_FOUND,
                format!("Index \"{name}\" does not exist"),
            )
        })
    }

    /// Returns the index called `name` where it is open, without opening a closed one.
    pub(crate) fn open_index_named(&self, name: &str) -> Option<Arc<IndexState>> {
        self.indexes().get(name).cloned()
    }

    /// Returns the index called `name` for a call, opening it again from its files where a close left it there.
    pub(crate) fn open_index(&self, name: &str) -> Result<Arc<IndexState>> {
        self.guard_shutdown()?;
        self.reach_index(name)
    }

    /// Returns the ID of a document inserted without one: the engine's ID generator's, or a new UUID version 7.
    pub(crate) fn next_document_id(&self) -> Result<String> {
        match &self.settings.id_generator {
            Some(generator) => ids::generated_id(generator),
            None => ids::generate_id(),
        }
    }
}

/// A search engine that holds indexes inside the calling process and searches them on Narsil's native core.
///
/// Every method takes `&self`, and the engine is `Send` and `Sync`, so threads share one engine through an
/// [`Arc`]. A search never waits for a write: each search reads the partitions as they stood when it began, while
/// the one writer of each index applies its changes in order.
pub struct Narsil {
    inner: Arc<EngineInner>,
}

impl Default for Narsil {
    fn default() -> Narsil {
        Narsil::new()
    }
}

impl Narsil {
    /// Returns an engine that holds no index and keeps everything in memory.
    pub fn new() -> Narsil {
        Narsil::with_durability(
            None,
            DEFAULT_PATTERN_WORK_CAP,
            EngineSettings::default(),
            None,
        )
    }

    fn with_durability(
        durable: Option<Durable>,
        pattern_work_cap: i64,
        settings: EngineSettings,
        scrambler: Option<query_suggestions::scramble::Scrambler>,
    ) -> Narsil {
        Narsil {
            inner: Arc::new_cyclic(|self_ref| EngineInner {
                indexes: RwLock::new(BTreeMap::new()),
                names: NameTurns::default(),
                analysis: AnalysisRegistry::default(),
                adapters: Arc::new(AdapterRegistry::with_rerank(settings.rerank)),
                durable,
                events: events::EventBus::default(),
                plugins: plugins::PluginRegistry::default(),
                pattern_work_cap,
                lifecycle: index_lifecycle::IndexLifecycle::new(settings.lifecycle),
                memory: memory::MemoryGuard::new(settings.memory),
                rebuild_queue: stale_review::RebuildQueue::default(),
                settings,
                self_ref: self_ref.clone(),
                suggestions: query_suggestions::runtime::SuggestionsRuntime::new(scrambler),
                shut_down: AtomicBool::new(false),
            }),
        }
    }

    /// Recovers every stored index, or with lifecycle limits records each one as closed until a call reaches it,
    /// and then goes on with the work that a restart interrupted.
    fn recover_stored(&self) -> Result<()> {
        let engine = &self.inner;
        if let Some(durable) = &engine.durable {
            let recovered = match engine.lifecycle.limits {
                Some(_) => durable.recover_closed(engine),
                None => durable.recover(engine),
            };
            if let Err(error) = recovered {
                let _ = durable.close();
                return Err(error);
            }
        }
        analysis_change::resume_interrupted_changes(engine);
        stale_review::review_stale(engine, engine.index_list());
        engine.lifecycle.sweeper.start(engine);
        Ok(())
    }

    /// Returns an engine that keeps its indexes as `config` says, after it recovers every index that the
    /// durability directory or the persistence adapter holds.
    ///
    /// Fails with `CONFIG_INVALID` where the durability settings break a rule, with `PERSISTENCE_LOCK_HELD`
    /// where another engine holds the directory, and with `PERSISTENCE_LOAD_FAILED` where a stored file is
    /// damaged. Recovery fails with `CONFIG_INVALID` for an index whose stored settings give a tokenizer or a
    /// stop word set by name, so open such a directory with [`Narsil::open_with`], which registers them first.
    pub fn open(config: NarsilConfig) -> Result<Narsil> {
        Narsil::open_with(config, |_| Ok(()))
    }

    /// Returns an engine that keeps its indexes as `config` says, once `register` has added the tokenizers, stop
    /// word sets, and adapters that the stored indexes give by name, and once every stored index has recovered.
    ///
    /// Fails with the first error that `register` returns, and otherwise as [`Narsil::open`] does.
    pub fn open_with(
        config: NarsilConfig,
        register: impl FnOnce(&Narsil) -> Result<()>,
    ) -> Result<Narsil> {
        workers::validate_workers(
            config.workers.as_ref(),
            config
                .lifecycle
                .as_ref()
                .and_then(|lifecycle| lifecycle.idle_timeout_ms),
        )?;
        let pattern_work_cap = resolve_pattern_work_cap(&config)?;
        let settings = engine_settings(&config)?;
        let scrambler = config
            .query_suggestions
            .as_ref()
            .map(|suggestions| query_suggestions::scramble::Scrambler::new(&suggestions.key))
            .transpose()?;
        let durable = match resolve_tier(&config)? {
            None => None,
            Some(ResolvedTier::Log(tier)) => Some(Durable::open_log(tier)?),
            Some(ResolvedTier::Snapshot(tier)) => Some(Durable::open_snapshot(tier)?),
        };
        let engine = Narsil::with_durability(durable, pattern_work_cap, settings, scrambler);
        register(&engine)?;
        engine.recover_stored()?;
        engine.inner.suggestions.start(&engine.inner);
        Ok(engine)
    }

    /// Creates an index that later calls reach by `name`.
    ///
    /// Fails with `INDEX_ALREADY_EXISTS` where the engine holds an index of that name, and with a schema or
    /// configuration code where `config` breaks a rule.
    pub fn create_index(&self, name: &str, config: IndexConfig) -> Result<()> {
        lifecycle::create_index(&self.inner, name, config)
    }

    /// Drops the index called `name` and every document that it holds.
    pub fn drop_index(&self, name: &str) -> Result<()> {
        lifecycle::drop_index(&self.inner, name)
    }

    /// Returns a summary of each index, in name order.
    pub fn list_indexes(&self) -> Vec<IndexInfo> {
        reads::list_indexes(&self.inner)
    }

    /// Stops the engine, after which every call fails with `INSTANCE_SHUT_DOWN`.
    ///
    /// A durable engine first flushes every log to the disk and releases its directory, and fails with
    /// `PERSISTENCE_SAVE_FAILED` where that flush fails; the engine stops either way.
    pub fn shutdown(&self) -> Result<()> {
        if self.inner.shut_down.load(Ordering::Acquire) {
            return Ok(());
        }
        self.inner.suggestions.stop(&self.inner);
        if self.inner.shut_down.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.inner.lifecycle.sweeper.stop();
        self.inner.lifecycle.clear();
        let indexes = std::mem::take(&mut *self.inner.indexes_mut());
        let closed = match &self.inner.durable {
            Some(durable) => durable.close(),
            None => Ok(()),
        };
        drop(indexes);
        self.inner.adapters.clear();
        closed
    }
}
