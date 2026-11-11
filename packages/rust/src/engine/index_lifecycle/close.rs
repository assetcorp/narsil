use std::sync::Arc;

use super::{ClosedEntry, ClosedIndex, index_not_found};
use crate::engine::EngineInner;
use crate::engine::durable::Durable;
use crate::engine::index::IndexState;
use crate::engine::sync::sync_is_on;
use crate::error::{ErrorCode, NarsilError, Result};

fn needs_durability() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "An index needs durability before it can close",
    )
}

pub(crate) fn closed_facts(index: &IndexState) -> ClosedIndex {
    let layout = index.partitions();
    ClosedIndex {
        config: index.config(),
        document_count: index.document_count(),
        partition_count: layout.len(),
        language: layout.analyser.language().name().to_string(),
        suggestions: index.suggestion_state(),
        sync_on: index
            .log()
            .is_some_and(|log| sync_is_on(&log.metadata(index))),
    }
}

/// Closes `index` once the caller holds its change slot and its name's turn: waits for the writes on it, writes
/// its checkpoint under its write lock, and only then takes it out of the engine, so that a failed checkpoint
/// leaves it open with every write in place.
///
/// An `automatic` close gives way where a write runs on the index, and reports whether it closed the index.
fn close_held(
    engine: &EngineInner,
    durable: &Durable,
    index: &Arc<IndexState>,
    automatic: bool,
) -> Result<bool> {
    let residency = &index.residency;
    residency.begin_close();
    if automatic && residency.active_writes() > 0 {
        residency.abandon_close();
        return Ok(false);
    }
    residency.wait_for_writes();
    let writer = index.write_lock();
    let closed = closed_facts(index);
    if let Err(error) = durable.checkpoint_for_close(index) {
        drop(writer);
        residency.abandon_close();
        return Err(error);
    }
    let released = durable.release_logs(&index.name);
    engine.lifecycle.record_closed(
        &index.name,
        ClosedEntry::new(closed, residency.reopen_count()),
    );
    engine.indexes_mut().remove(&index.name);
    index.retire();
    engine.lifecycle.changed.notify_all();
    drop(writer);
    residency.finish_close();
    released.map(|()| true)
}

/// Closes the index called `name` and reports whether it is closed afterwards.
///
/// An explicit close waits for the rebuild and the writes that run on the index, and for any create, drop, or
/// restore of the name. An `automatic` close, which the idle timeout and the open limits start, gives way to each
/// of them and reports `false`.
pub(crate) fn close_index(engine: &EngineInner, name: &str, automatic: bool) -> Result<bool> {
    engine.guard_shutdown()?;
    loop {
        let Some(index) = engine.open_index_named(name) else {
            if engine.lifecycle.holds_closed(name) {
                return Ok(true);
            }
            if engine.holds_index(name) {
                continue;
            }
            return Err(index_not_found(name));
        };
        let durable = engine.durable.as_ref().ok_or_else(needs_durability)?;
        let Some(ticket) = index.changes.hold_for_close(&index.name, !automatic)? else {
            return Ok(false);
        };
        let turn = match automatic {
            true => match engine.names.try_take(name) {
                Some(turn) => turn,
                None => return Ok(false),
            },
            false => engine.names.take(name),
        };
        let current = engine.open_index_named(name);
        if !current.is_some_and(|current| Arc::ptr_eq(&current, &index)) {
            drop(turn);
            drop(ticket);
            if automatic {
                return Ok(false);
            }
            continue;
        }
        engine.guard_shutdown()?;
        let closed = close_held(engine, durable, &index, automatic);
        drop(turn);
        drop(ticket);
        return closed;
    }
}
