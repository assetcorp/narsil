use super::constants::LARGEST_SAFE_INTEGER;
use crate::error::{ErrorCode, NarsilError, Result};

/// Which queries TypeScript's engine answers on its main copy, kept so that one configuration reads the same in
/// both packages.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MainCopyQueries {
    /// The main copy answers a query while every worker copy holds one, which is TypeScript's default.
    #[default]
    Lone,
    /// Every query goes to a worker copy.
    None,
}

/// The worker settings of TypeScript's engine, which this crate checks the way TypeScript checks them and then
/// leaves without effect.
///
/// TypeScript holds a copy of each large index on every worker thread, because its threads share no memory. This
/// crate's threads share one memory, so every thread searches the one copy of each index, and the partitioning
/// specification's rules for worker copies, their count, their threshold, and their idle interval do not apply.
/// [`crate::Narsil::open`] still refuses each value that TypeScript refuses, with `CONFIG_INVALID`, so that a
/// configuration that one package accepts the other accepts too.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkerConfig {
    /// Whether TypeScript's engine may hold worker copies, which it does everywhere but a browser page by default.
    /// It changes nothing in this crate.
    pub enabled: Option<bool>,
    /// The number of worker threads in TypeScript's engine: the host's cores minus one, from 2 to 8, by default,
    /// and at most 31 where you set it. It must be a whole number from 1 to 2^53 - 1, and it changes nothing in
    /// this crate.
    pub count: Option<u64>,
    /// The number of documents at which TypeScript's engine gives an index worker copies, 1,000 by default. It must
    /// be a whole number from 1 to 2^53 - 1, and it changes nothing in this crate.
    pub promotion_threshold: Option<u64>,
    /// The milliseconds without a read or a write after which TypeScript's engine drops an index's worker copies,
    /// five minutes by default. It must be a whole number from 1 to 2^53 - 1, and it changes nothing in this crate.
    pub idle_timeout_ms: Option<u64>,
    /// Which queries TypeScript's engine answers on its main copy, [`MainCopyQueries::Lone`] by default. It changes
    /// nothing in this crate.
    pub main_copy_queries: Option<MainCopyQueries>,
}

fn require_positive_safe_integer(field: &str, value: Option<u64>) -> Result<()> {
    match value {
        Some(value) if value == 0 || value > LARGEST_SAFE_INTEGER => Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!("{field} must be a positive safe integer, got {value}"),
        )),
        _ => Ok(()),
    }
}

/// Refuses with `CONFIG_INVALID` each worker setting that TypeScript's engine refuses, where
/// `lifecycle_idle_timeout_ms` is the interval after which the engine closes an idle index, if it sets one.
pub(crate) fn validate_workers(
    workers: Option<&WorkerConfig>,
    lifecycle_idle_timeout_ms: Option<u64>,
) -> Result<()> {
    let Some(workers) = workers else {
        return Ok(());
    };
    require_positive_safe_integer("workers.count", workers.count)?;
    require_positive_safe_integer("workers.promotionThreshold", workers.promotion_threshold)?;
    require_positive_safe_integer("workers.idleTimeoutMs", workers.idle_timeout_ms)?;
    match (workers.idle_timeout_ms, lifecycle_idle_timeout_ms) {
        (Some(drop_after), Some(close_after)) if drop_after > close_after => Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "workers.idleTimeoutMs must be at most lifecycle.idleTimeoutMs, so that an index drops its copies before it closes, got {drop_after} and {close_after}"
            ),
        )),
        _ => Ok(()),
    }
}
