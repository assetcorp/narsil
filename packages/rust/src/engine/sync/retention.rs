use super::constants::DEFAULT_HISTORY_MAX_AGE_MS;
use super::{release_sync, sync_epoch_of, sync_is_on};
use crate::durability::platform::now_ms;
use crate::durability::store::DurabilityStore;
use crate::durability::sync_files::PublishedSnapshot;
use crate::durability::sync_retention::{HistoryLimits, published_archive_bytes};
use crate::engine::EngineInner;
use crate::engine::durable::archive::{
    archive_checkpoint, current_metadata, encoded_configuration,
};
use crate::engine::durable::constants::MAX_SNAPSHOT_ANALYSIS_ATTEMPTS;
use crate::engine::events::NarsilEvent;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};

fn sync_changed(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::SYNC_NOT_ENABLED,
        format!(
            "The device sync state of index \"{index_name}\" changed while the engine published its snapshot"
        ),
    )
}

/// Publishes a snapshot of a synced index from a new checkpoint, whose files stay pinned until the published
/// snapshot lists them. Where the epoch changes or sync goes off meanwhile, the engine releases what it published.
fn publish(index: &IndexState, store: &DurabilityStore) -> Result<PublishedSnapshot> {
    for _ in 0..MAX_SNAPSHOT_ANALYSIS_ATTEMPTS {
        let checkpoint = archive_checkpoint(index)?;
        let metadata = current_metadata(index);
        if checkpoint.manifest.analysis_generation.unwrap_or(0)
            != metadata.analysis_generation.unwrap_or(0)
        {
            continue;
        }
        let Some(epoch) = sync_epoch_of(&metadata).map(str::to_string) else {
            return Err(sync_changed(&index.name));
        };
        let config = encoded_configuration(index, &metadata)?;
        let published = store.publish_snapshot(&index.name, &config, &checkpoint.manifest_bytes)?;
        drop(checkpoint);
        let _writer = index.lock_writes()?;
        let now = current_metadata(index);
        if sync_epoch_of(&now) != Some(epoch.as_str()) {
            release_sync(index)?;
            return Err(sync_changed(&index.name));
        }
        return Ok(published);
    }
    Err(NarsilError::new(
        ErrorCode::ANALYSIS_CHANGE_NOT_READY,
        format!(
            "The analysis of index \"{}\" changed while the engine published its snapshot",
            index.name
        ),
    ))
}

fn limits_of(index: &IndexState, store: &DurabilityStore) -> Option<HistoryLimits> {
    let metadata = current_metadata(index);
    if !sync_is_on(&metadata) || metadata.sync_active != Some(true) {
        return None;
    }
    let sync = metadata.sync.as_ref()?;
    let max_bytes = match sync.history_max_bytes {
        Some(bytes) => bytes,
        None => store
            .published_snapshot(&index.name)
            .map_or(u64::MAX, |published| {
                published_archive_bytes(&published, &index.name)
            }),
    };
    Some(HistoryLimits {
        max_age_ms: sync
            .history_max_age_ms
            .unwrap_or(DEFAULT_HISTORY_MAX_AGE_MS),
        max_bytes,
    })
}

fn enforce(index: &IndexState, store: &DurabilityStore) -> Result<()> {
    let Some(limits) = limits_of(index, store) else {
        return Ok(());
    };
    let mut publish_now = || publish(index, store);
    store.enforce_history(&index.name, &limits, now_ms(), &mut publish_now)?;
    Ok(())
}

/// Applies the history limits of every synced index whose checkpoint moved log segments into history since the
/// last pass, or of every synced index where `sweep` is set, reporting a failure as a `DurabilityError` event.
pub(crate) fn enforce_history_limits(engine: &EngineInner, sweep: bool) {
    for index in engine.index_list() {
        let Some(store) = index.log().and_then(|log| log.log_store()) else {
            continue;
        };
        let mut due = store.take_history_moved(&index.name) || sweep;
        while due {
            match enforce(&index, store) {
                Ok(()) => {}
                Err(error) if error.code() == ErrorCode::SYNC_NOT_ENABLED => break,
                Err(error) => {
                    engine.events.emit(NarsilEvent::DurabilityError {
                        index_name: index.name.clone(),
                        error,
                    });
                    break;
                }
            }
            due = store.take_history_moved(&index.name);
        }
    }
}
