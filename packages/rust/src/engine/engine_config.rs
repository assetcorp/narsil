use std::sync::Arc;

use super::durable::config::NarsilConfig;
use super::index_lifecycle::constants::DEFAULT_MAX_REOPEN_WAITERS;
use super::memory::constants::{DEFAULT_BLOCK_WRITES_ABOVE, DEFAULT_RESUME_WRITES_BELOW};
use super::rerank_settings::RerankSettings;
use super::stale_review::StaleRebuild;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::MAX_SAFE_INTEGER;

/// Returns the ID of a document inserted without one, in place of the UUID version 7 that the engine generates by
/// default. Where the function panics, the insert fails with `INTERNAL_ERROR` and the text that the panic carried.
pub type IdGenerator = Arc<dyn Fn() -> String + Send + Sync>;

/// Hears each index whose stored terms came from an older analysis than its language module produces now,
/// with the handle that rebuilds it.
pub type StaleAnalysisListener = Arc<dyn Fn(&StaleAnalysis, StaleRebuild) + Send + Sync>;

/// Limits on the indexes that one durable engine keeps open in memory. A closed index keeps its files, and the
/// next call that reaches it opens it again.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexLifecycleConfig {
    /// An index closes after this many milliseconds without a call.
    pub idle_timeout_ms: Option<u64>,
    /// The engine keeps at most this many indexes open at once, closing the least recently used.
    pub max_open_indexes: Option<u64>,
    /// The open indexes may hold at most this many estimated bytes together, the least recently used closing
    /// first.
    pub max_open_bytes: Option<u64>,
    /// At most this many calls may wait behind the close or the reopen of one index, 64 by default; a call past
    /// the limit fails with `INDEX_REOPEN_CAPACITY_EXHAUSTED`.
    pub max_reopen_waiters: Option<u64>,
}

/// The memory levels at which an engine stops and resumes accepting inserts and updates, as fractions of the
/// process's memory limit.
///
/// The engine reads the process's resident memory and its limit before a write once its last reading is more
/// than a second old. The limit is the cgroup's memory limit on Linux where one is set below the machine's
/// memory, and otherwise the machine's memory, which Linux counts as the resident memory plus the memory
/// available. A full engine refuses each insert and update with `MEMORY_WRITE_BLOCKED`, and keeps accepting
/// removes, searches, and reads, so that removing documents frees memory.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MemoryConfig {
    /// The engine counts as full once its resident memory passes this fraction of the limit: above
    /// `resume_writes_below`, at most 1, and 0.9 by default.
    pub block_writes_above: Option<f64>,
    /// A full engine accepts writes again once its resident memory falls below this fraction of the limit: above
    /// 0, below `block_writes_above`, and 0.8 by default.
    pub resume_writes_below: Option<f64>,
}

/// Whether the engine rebuilds an index whose stored terms are stale without being asked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AnalysisRebuildMode {
    /// The engine rebuilds each stale index on a background thread, one index at a time.
    #[default]
    Auto,
    /// The engine leaves each stale index until [`crate::Narsil::rebuild_analysis`] or a [`StaleRebuild`] runs.
    Manual,
}

/// An index whose stored terms came from an older analysis than its language module produces now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleAnalysis {
    /// The index that holds the stale terms.
    pub index_name: String,
    /// The language module that analyses the index.
    pub language: String,
    /// The revision that the stored terms record, or `None` for terms written before revisions existed.
    pub stored_revision: Option<String>,
    /// The revision that the language module carries now.
    pub current_revision: String,
    /// The number of documents that a rebuild reindexes.
    pub document_count: u64,
}

/// What the engine does when it opens an index whose stored terms are stale.
#[derive(Clone, Default)]
pub struct AnalysisConfig {
    /// `Auto` rebuilds each stale index in the background, and `Manual` leaves it to the program.
    pub rebuild: Option<AnalysisRebuildMode>,
    /// The engine calls this once for each stale index that it opens, before an automatic rebuild starts. A
    /// panic inside it raises a failed analysis rebuild event.
    pub on_stale_analysis: Option<StaleAnalysisListener>,
}

impl std::fmt::Debug for AnalysisConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AnalysisConfig")
            .field("rebuild", &self.rebuild)
            .field("on_stale_analysis", &self.on_stale_analysis.is_some())
            .finish()
    }
}

/// The lifecycle limits of an engine once checked, with each default filled in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LifecycleLimits {
    pub(crate) idle_timeout_ms: Option<u64>,
    pub(crate) max_open_indexes: Option<u64>,
    pub(crate) max_open_bytes: Option<u64>,
    pub(crate) max_reopen_waiters: usize,
}

/// The memory fractions of an engine once checked.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MemoryFractions {
    pub(crate) block: f64,
    pub(crate) resume: f64,
}

/// Every engine setting outside durability, once checked.
pub(crate) struct EngineSettings {
    pub(crate) id_generator: Option<IdGenerator>,
    pub(crate) rebuild_mode: AnalysisRebuildMode,
    pub(crate) on_stale_analysis: Option<StaleAnalysisListener>,
    pub(crate) lifecycle: Option<LifecycleLimits>,
    pub(crate) memory: MemoryFractions,
    pub(crate) rerank: RerankSettings,
}

impl Default for EngineSettings {
    fn default() -> EngineSettings {
        EngineSettings {
            id_generator: None,
            rebuild_mode: AnalysisRebuildMode::Auto,
            on_stale_analysis: None,
            lifecycle: None,
            memory: MemoryFractions {
                block: DEFAULT_BLOCK_WRITES_ABOVE,
                resume: DEFAULT_RESUME_WRITES_BELOW,
            },
            rerank: RerankSettings::default(),
        }
    }
}

fn config_invalid(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

fn positive_limit(name: &str, value: Option<u64>) -> Result<Option<u64>> {
    match value {
        Some(value) if value == 0 || value > MAX_SAFE_INTEGER => Err(config_invalid(format!(
            "lifecycle.{name} must be a positive safe integer"
        ))),
        _ => Ok(value),
    }
}

fn lifecycle_limits(config: &IndexLifecycleConfig) -> Result<LifecycleLimits> {
    let idle_timeout_ms = positive_limit("idleTimeoutMs", config.idle_timeout_ms)?;
    let max_open_indexes = positive_limit("maxOpenIndexes", config.max_open_indexes)?;
    let max_open_bytes = positive_limit("maxOpenBytes", config.max_open_bytes)?;
    let waiters = match config.max_reopen_waiters {
        Some(value) if value > MAX_SAFE_INTEGER => {
            return Err(config_invalid(
                "lifecycle.maxReopenWaiters must be a non-negative safe integer".to_string(),
            ));
        }
        Some(value) => usize::try_from(value).unwrap_or(usize::MAX),
        None => DEFAULT_MAX_REOPEN_WAITERS,
    };
    Ok(LifecycleLimits {
        idle_timeout_ms,
        max_open_indexes,
        max_open_bytes,
        max_reopen_waiters: waiters,
    })
}

fn require_fraction(name: &str, value: Option<f64>) -> Result<()> {
    match value {
        Some(value) if !(value.is_finite() && value > 0.0 && value <= 1.0) => Err(config_invalid(
            format!("memory.{name} must be a number above 0 and at most 1"),
        )),
        _ => Ok(()),
    }
}

fn memory_fractions(config: Option<&MemoryConfig>) -> Result<MemoryFractions> {
    let Some(config) = config else {
        return Ok(EngineSettings::default().memory);
    };
    require_fraction("blockWritesAbove", config.block_writes_above)?;
    require_fraction("resumeWritesBelow", config.resume_writes_below)?;
    let block = config
        .block_writes_above
        .unwrap_or(DEFAULT_BLOCK_WRITES_ABOVE);
    let resume = config
        .resume_writes_below
        .unwrap_or(DEFAULT_RESUME_WRITES_BELOW);
    if resume >= block {
        return Err(config_invalid(format!(
            "memory.resumeWritesBelow ({resume}) must lie below blockWritesAbove ({block})"
        )));
    }
    Ok(MemoryFractions { block, resume })
}

/// Checks every engine setting outside durability in the order that every Narsil engine checks them, raising
/// `CONFIG_INVALID` for the first that breaks a rule.
pub(crate) fn engine_settings(config: &NarsilConfig) -> Result<EngineSettings> {
    let rerank = RerankSettings::checked(config.rerank_timeout_ms, config.max_rerank_window)?;
    let lifecycle = config
        .lifecycle
        .as_ref()
        .map(lifecycle_limits)
        .transpose()?;
    let memory = memory_fractions(config.memory.as_ref())?;
    let analysis = config.analysis.clone().unwrap_or_default();
    Ok(EngineSettings {
        id_generator: config.id_generator.clone(),
        rebuild_mode: analysis.rebuild.unwrap_or_default(),
        on_stale_analysis: analysis.on_stale_analysis,
        lifecycle,
        memory,
        rerank,
    })
}
