use std::path::PathBuf;
use std::sync::Arc;

use crate::durability::constants::DEFAULT_COMPACTION_THRESHOLD;
use crate::durability::persistence::PersistenceAdapter;
use crate::durability::store_config::{DurabilityMode as StoreMode, StoreConfig};
use crate::engine::query_suggestions::types::QuerySuggestionsConfig;
use crate::engine::workers::WorkerConfig;
use crate::engine::{AnalysisConfig, IdGenerator, IndexLifecycleConfig, MemoryConfig};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;
use crate::pattern::constants::{DEFAULT_PATTERN_WORK_CAP, MAX_PATTERN_WORK_CAP};

/// How an engine keeps its indexes across a restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityTier {
    /// The engine logs every write before it answers, and checkpoints the log into segment files.
    Wal,
    /// The engine writes whole checkpoints through a persistence adapter on an interval, and a crash loses the
    /// writes made since the last one.
    Snapshot,
}

/// When a logged write reaches the disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityMode {
    /// Each write flushes the log to the disk before it returns.
    Sync,
    /// A background thread flushes the log on an interval, so a crash can lose the writes of that interval.
    Async,
}

/// The durability settings of an engine, each left at its default where it is `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DurabilityConfig {
    /// `Wal` logs every write, and `Snapshot` writes whole checkpoints on an interval.
    pub tier: Option<DurabilityTier>,
    /// The directory that holds the log and its checkpoints.
    pub directory: Option<PathBuf>,
    /// `Sync` flushes before a write returns, and `Async` flushes on the interval below.
    pub mode: Option<DurabilityMode>,
    /// In `Async` mode the engine flushes this many milliseconds apart, 1,000 by default.
    pub flush_interval_ms: Option<u64>,
    /// The log starts a new file once a file reaches this many bytes, 64 MiB by default.
    pub segment_max_bytes: Option<u64>,
    /// The engine checkpoints this many milliseconds apart, which shortens the replay of a restart; 300,000 by
    /// default, and 0 turns the interval off.
    pub checkpoint_interval_ms: Option<u64>,
    /// This many writes start a checkpoint before the interval elapses, 100,000 by default.
    pub checkpoint_mutation_threshold: Option<u64>,
    /// The engine merges a partition's checkpoint segments once the partition holds more than this many, 12 by
    /// default.
    pub compaction_threshold: Option<u32>,
}

/// Everything that an engine opens with.
#[derive(Clone, Default)]
pub struct NarsilConfig {
    /// How the engine keeps its indexes across a restart, or `None` to keep them in memory alone.
    pub durability: Option<DurabilityConfig>,
    /// The store of a snapshot-tier engine, or of a log-tier engine whose adapter names a directory.
    pub persistence: Option<Arc<dyn PersistenceAdapter>>,
    /// The most work that one search may spend on its pattern tests and phrases, 25,000,000 units by default.
    ///
    /// A pattern test adds one unit for each code point that it reads and each value in its list, and a typo
    /// tolerant `eq` test adds one unit for each cell of its edit distance table, in the units that every Narsil
    /// engine counts. Once a search passes the cap, it fails with `SEARCH_WORK_CAP_EXCEEDED`. [`crate::Narsil::open`]
    /// fails with `CONFIG_INVALID` for 0 or for a cap above 9,007,199,254,740,991.
    pub pattern_work_cap: Option<u64>,
    /// TypeScript's worker settings, which [`crate::Narsil::open`] checks as TypeScript does and which change
    /// nothing in this crate, because every thread searches the one copy of each index.
    pub workers: Option<WorkerConfig>,
    /// When the engine closes an idle index and how many indexes it keeps open, or `None` to keep every index
    /// open. With limits set, a restart leaves each stored index closed until a call reaches it.
    pub lifecycle: Option<IndexLifecycleConfig>,
    /// The fractions of process memory at which inserts and updates stop and start again, 0.9 and 0.8 by default.
    pub memory: Option<MemoryConfig>,
    /// What the engine does with an index whose stored analysis revision differs from its language module's.
    pub analysis: Option<AnalysisConfig>,
    /// The function that gives the ID of a document inserted without one, or `None` for a UUID version 7.
    pub id_generator: Option<IdGenerator>,
    /// How many milliseconds a rerank adapter may take before the query fails with `RERANK_FAILED`, 30,000 by
    /// default and from 1 to 2,147,483,647.
    pub rerank_timeout_ms: Option<u64>,
    /// The most hits that one query may rerank, 100 by default and from 1 to 1,000.
    pub max_rerank_window: Option<usize>,
    /// The key of popular query suggestions, or `None` for an engine that counts no searches.
    pub query_suggestions: Option<QuerySuggestionsConfig>,
}

impl std::fmt::Debug for NarsilConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NarsilConfig")
            .field("durability", &self.durability)
            .field("persistence", &self.persistence.is_some())
            .field("pattern_work_cap", &self.pattern_work_cap)
            .field("workers", &self.workers)
            .field("lifecycle", &self.lifecycle)
            .field("memory", &self.memory)
            .field("analysis", &self.analysis)
            .field("id_generator", &self.id_generator.is_some())
            .field("rerank_timeout_ms", &self.rerank_timeout_ms)
            .field("max_rerank_window", &self.max_rerank_window)
            .field("query_suggestions", &self.query_suggestions)
            .finish()
    }
}

/// Returns the pattern work cap of an engine, and raises `CONFIG_INVALID` for a cap outside 1 to
/// 9,007,199,254,740,991.
pub(crate) fn resolve_pattern_work_cap(config: &NarsilConfig) -> Result<i64> {
    let Some(cap) = config.pattern_work_cap else {
        return Ok(DEFAULT_PATTERN_WORK_CAP);
    };
    match i64::try_from(cap) {
        Ok(cap) if (1..=MAX_PATTERN_WORK_CAP).contains(&cap) => Ok(cap),
        _ => Err(config_error(format!(
            "The configuration sets \"patternWorkCap\" to {cap}, while the cap must be a whole number from 1 to {MAX_PATTERN_WORK_CAP}"
        ))),
    }
}

pub(crate) struct LogTier {
    pub(crate) store: StoreConfig,
    pub(crate) compaction_threshold: u32,
}

pub(crate) struct SnapshotTier {
    pub(crate) adapter: Arc<dyn PersistenceAdapter>,
    pub(crate) checkpoint_interval_ms: Option<u64>,
    pub(crate) checkpoint_mutation_threshold: Option<u64>,
}

pub(crate) enum ResolvedTier {
    Log(LogTier),
    Snapshot(SnapshotTier),
}

fn config_error(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

fn require_at_least(name: &str, value: Option<u64>, minimum: u64) -> Result<()> {
    match value {
        Some(value) if value < minimum => Err(config_error(format!(
            "durability.{name} must be a finite number of at least {minimum}, got {value}"
        ))),
        _ => Ok(()),
    }
}

fn require_valid(durability: &DurabilityConfig) -> Result<()> {
    require_at_least(
        "checkpointMutationThreshold",
        durability.checkpoint_mutation_threshold,
        1,
    )?;
    require_at_least("segmentMaxBytes", durability.segment_max_bytes, 1)?;
    if let Some(bytes) = durability.segment_max_bytes
        && bytes > MAX_FILE_BYTES
    {
        return Err(config_error(format!(
            "durability.segmentMaxBytes must be at most {MAX_FILE_BYTES}, the largest file that every implementation reads, got {bytes}"
        )));
    }
    require_at_least(
        "compactionThreshold",
        durability.compaction_threshold.map(u64::from),
        1,
    )?;
    if durability.tier != Some(DurabilityTier::Snapshot) {
        return Ok(());
    }
    let log_only = [
        ("directory", durability.directory.is_some()),
        ("mode", durability.mode.is_some()),
        ("flushIntervalMs", durability.flush_interval_ms.is_some()),
        ("segmentMaxBytes", durability.segment_max_bytes.is_some()),
        (
            "compactionThreshold",
            durability.compaction_threshold.is_some(),
        ),
    ];
    match log_only.iter().find(|(_, set)| *set) {
        Some((field, _)) => Err(config_error(format!(
            "durability.{field} applies to the write-ahead log tier only and cannot combine with durability.tier \"snapshot\""
        ))),
        None => Ok(()),
    }
}

fn usable_directory(directory: Option<&std::path::Path>) -> Option<PathBuf> {
    directory
        .filter(|path| !path.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

fn log_tier(durability: &DurabilityConfig, directory: PathBuf) -> LogTier {
    let mut store = StoreConfig::new(directory);
    if durability.mode == Some(DurabilityMode::Async) {
        store.mode = StoreMode::Async;
    }
    if let Some(interval) = durability.flush_interval_ms {
        store.flush_interval_ms = interval;
    }
    if let Some(bytes) = durability.segment_max_bytes {
        store.segment_max_bytes = bytes;
    }
    if let Some(interval) = durability.checkpoint_interval_ms {
        store.checkpoint_interval_ms = interval;
    }
    if let Some(threshold) = durability.checkpoint_mutation_threshold {
        store.checkpoint_mutation_threshold = threshold;
    }
    LogTier {
        store,
        compaction_threshold: durability
            .compaction_threshold
            .unwrap_or(DEFAULT_COMPACTION_THRESHOLD),
    }
}

/// Chooses the durability tier of an engine in the order that every Narsil engine chooses it.
pub(crate) fn resolve_tier(config: &NarsilConfig) -> Result<Option<ResolvedTier>> {
    let adapter_directory = config
        .persistence
        .as_ref()
        .and_then(|adapter| usable_directory(adapter.directory()));
    let Some(durability) = &config.durability else {
        return Ok(config
            .persistence
            .as_ref()
            .map(|adapter| match &adapter_directory {
                Some(directory) => {
                    ResolvedTier::Log(log_tier(&DurabilityConfig::default(), directory.clone()))
                }
                None => ResolvedTier::Snapshot(SnapshotTier {
                    adapter: Arc::clone(adapter),
                    checkpoint_interval_ms: None,
                    checkpoint_mutation_threshold: None,
                }),
            }));
    };
    require_valid(durability)?;
    if durability.tier == Some(DurabilityTier::Snapshot) {
        let Some(adapter) = &config.persistence else {
            return Err(config_error(
                "Snapshot durability persists through a persistence adapter. Configure persistence, or remove durability.tier".to_string(),
            ));
        };
        return Ok(Some(ResolvedTier::Snapshot(SnapshotTier {
            adapter: Arc::clone(adapter),
            checkpoint_interval_ms: durability.checkpoint_interval_ms,
            checkpoint_mutation_threshold: durability.checkpoint_mutation_threshold,
        })));
    }
    if let Some(directory) = usable_directory(durability.directory.as_deref()) {
        return Ok(Some(ResolvedTier::Log(log_tier(durability, directory))));
    }
    if let Some(directory) = adapter_directory {
        return Ok(Some(ResolvedTier::Log(log_tier(durability, directory))));
    }
    if config.persistence.is_some() {
        return Err(config_error(
            "WAL durability requires a filesystem directory, but the configured persistence adapter is not filesystem-backed. Use a filesystem persistence adapter or set durability.directory".to_string(),
        ));
    }
    Err(config_error(
        "Durability requires a directory. Set durability.directory explicitly, or configure a filesystem persistence adapter".to_string(),
    ))
}
