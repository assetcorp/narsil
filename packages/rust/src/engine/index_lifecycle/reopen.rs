use std::sync::Arc;
use std::time::{Duration, Instant};

use super::constants::{MAX_REOPEN_BACKOFF_EXPONENT, MAX_REOPEN_FAILURES, REOPEN_BACKOFF_BASE_MS};
use super::residency::waiters_exhausted;
use super::{enforce_limits, index_not_found};
use crate::engine::EngineInner;
use crate::engine::analysis_change::resume_interrupted_change;
use crate::engine::index::IndexState;
use crate::engine::stale_review::review_stale;
use crate::error::{ErrorCode, NarsilError, Result};

enum Claim {
    Open(Arc<IndexState>),
    Load,
    Loaded(Arc<IndexState>),
}

/// Waits behind a reopen of `name` that another call runs, or claims the reopen for this call.
///
/// A call that finds the most waiters that the lifecycle settings allow fails with
/// `INDEX_REOPEN_CAPACITY_EXHAUSTED`. An implicit call fails with the last reopen error while the backoff after a
/// failed reopen runs and after five failures in a row, which an explicit open clears.
fn claim(engine: &EngineInner, name: &str, explicit: bool) -> Result<Claim> {
    let lifecycle = &engine.lifecycle;
    let limit = lifecycle.waiter_limit();
    let mut registry = lifecycle.registry();
    loop {
        if let Some(index) = engine.open_index_named(name) {
            return Ok(Claim::Open(index));
        }
        let Some(entry) = registry.entries.get_mut(name) else {
            return Err(index_not_found(name));
        };
        if entry.reopening {
            let waiting = registry.waiters.get(name).copied().unwrap_or(0);
            if waiting >= limit {
                return Err(waiters_exhausted(name, limit));
            }
            registry.waiters.insert(name.to_string(), waiting + 1);
            registry = lifecycle
                .changed
                .wait(registry)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let left = registry.waiters.get(name).copied().unwrap_or(1) - 1;
            match left {
                0 => registry.waiters.remove(name),
                left => registry.waiters.insert(name.to_string(), left),
            };
            continue;
        }
        if explicit {
            entry.failures = 0;
            entry.retry_at = None;
            entry.last_error = None;
            entry.reopen_failed = false;
        }
        let backing_off = entry
            .retry_at
            .is_some_and(|retry_at| Instant::now() < retry_at);
        if (entry.reopen_failed || backing_off)
            && let Some(error) = &entry.last_error
        {
            return Err(error.clone());
        }
        entry.reopening = true;
        return Ok(Claim::Load);
    }
}

fn needs_durability() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "An index needs durability before it can reopen",
    )
}

/// Loads the closed index `name` from its files and puts it in the engine's map of indexes, under the name's
/// turn, so that no create, drop, restore, or close of the name runs meanwhile.
fn load_closed(engine: &EngineInner, name: &str) -> Result<Claim> {
    engine.guard_shutdown()?;
    let _turn = engine.names.take(name);
    if let Some(index) = engine.open_index_named(name) {
        engine.lifecycle.forget(name);
        return Ok(Claim::Open(index));
    }
    if !engine.lifecycle.holds_closed(name) {
        return Err(index_not_found(name));
    }
    let durable = engine.durable.as_ref().ok_or_else(needs_durability)?;
    let index = match durable.reopen_index(engine, name) {
        Ok(Some(index)) => index,
        Ok(None) => {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "Index \"{name}\" could not be reopened, because its metadata file is missing"
                ),
            ));
        }
        Err(error) => {
            durable.release_logs(name).ok();
            return Err(error);
        }
    };
    let lifecycle = &engine.lifecycle;
    {
        let mut registry = lifecycle.registry();
        let reopens = registry
            .entries
            .remove(name)
            .map_or(0, |entry| entry.reopen_count);
        index.residency.set_reopen_count(reopens.saturating_add(1));
        lifecycle.touch(&index);
        engine
            .indexes_mut()
            .insert(name.to_string(), Arc::clone(&index));
    }
    lifecycle.changed.notify_all();
    Ok(Claim::Loaded(index))
}

fn backoff(failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(MAX_REOPEN_BACKOFF_EXPONENT);
    Duration::from_millis(REOPEN_BACKOFF_BASE_MS << exponent)
}

/// Records a failed reopen of `name`: the error that each call meets during the backoff, and a parked failure
/// after five in a row.
fn record_failure(engine: &EngineInner, name: &str, error: &NarsilError) {
    let lifecycle = &engine.lifecycle;
    {
        let mut registry = lifecycle.registry();
        if let Some(entry) = registry.entries.get_mut(name) {
            entry.reopening = false;
            entry.failures = entry.failures.saturating_add(1);
            entry.last_error = Some(error.clone());
            entry.retry_at = Some(Instant::now() + backoff(entry.failures));
            entry.reopen_failed = entry.failures >= MAX_REOPEN_FAILURES;
        }
    }
    lifecycle.changed.notify_all();
}

/// Goes on with the work that a close interrupted: an analysis change that the metadata file records, and the
/// rebuild of stale terms.
fn resume_work(engine: &EngineInner, index: &Arc<IndexState>) {
    let Some(engine) = engine.self_ref.upgrade() else {
        return;
    };
    resume_interrupted_change(&engine, index);
    review_stale(&engine, vec![Arc::clone(index)]);
}

/// Returns the index called `name`, opening it again from its files where a close left it there. An `explicit`
/// call first clears a parked reopen failure.
pub(crate) fn reopen_index(
    engine: &EngineInner,
    name: &str,
    explicit: bool,
) -> Result<Arc<IndexState>> {
    if let Claim::Open(index) | Claim::Loaded(index) = claim(engine, name, explicit)? {
        return Ok(index);
    }
    match load_closed(engine, name) {
        Ok(Claim::Loaded(index)) => {
            resume_work(engine, &index);
            enforce_limits(engine, Some(name));
            Ok(index)
        }
        Ok(Claim::Open(index)) => Ok(index),
        Ok(Claim::Load) => Err(index_not_found(name)),
        Err(error) => {
            record_failure(engine, name, &error);
            Err(error)
        }
    }
}
