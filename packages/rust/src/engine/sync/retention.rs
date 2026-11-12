use super::constants::DEFAULT_HISTORY_MAX_AGE_MS;
use super::{release_sync, sync_epoch_of, sync_is_on};
use crate::durability::platform::now_ms;
use crate::durability::store::DurabilityStore;
use crate::durability::sync_files::PublishedSnapshot;
use crate::durability::sync_retention::{HistoryLimits, published_archive_bytes};
use crate::engine::EngineInner;
use crate::engine::change_capture::constants::MIN_DEFAULT_CHANGES_HISTORY_BYTES;
use crate::engine::durable::archive::{
    archive_checkpoint, current_metadata, encoded_configuration,
};
use crate::engine::durable::constants::MAX_SNAPSHOT_ANALYSIS_ATTEMPTS;
use crate::engine::events::NarsilEvent;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;

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
        let Some(epoch) = sync_epoch_of(&metadata)
            .filter(|_| sync_is_on(&metadata))
            .map(str::to_string)
        else {
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
        if !sync_is_on(&now) {
            store.release_sync_files(&index.name, !now.keeps_history())?;
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

fn sync_limits(
    metadata: &IndexMetadata,
    index_name: &str,
    store: &DurabilityStore,
) -> Option<HistoryLimits> {
    if !metadata.sync_is_active() {
        return None;
    }
    let sync = metadata.sync.as_ref()?;
    let max_bytes = match sync.history_max_bytes {
        Some(bytes) => bytes,
        None => store
            .published_snapshot(index_name)
            .map_or(u64::MAX, |published| {
                published_archive_bytes(&published, index_name)
            }),
    };
    Some(HistoryLimits {
        max_age_ms: sync
            .history_max_age_ms
            .unwrap_or(DEFAULT_HISTORY_MAX_AGE_MS),
        max_bytes,
    })
}

fn changes_limits(
    metadata: &IndexMetadata,
    index_name: &str,
    store: &DurabilityStore,
) -> Result<Option<HistoryLimits>> {
    let Some(changes) = metadata.changes.filter(|changes| changes.enabled) else {
        return Ok(None);
    };
    let max_bytes = match changes.history_max_bytes {
        Some(bytes) => bytes,
        None => store
            .checkpoint_bytes(index_name)?
            .max(MIN_DEFAULT_CHANGES_HISTORY_BYTES),
    };
    Ok(Some(HistoryLimits {
        max_age_ms: changes
            .history_max_age_ms
            .unwrap_or(DEFAULT_HISTORY_MAX_AGE_MS),
        max_bytes,
    }))
}

fn enforce(index: &IndexState, store: &DurabilityStore) -> Result<()> {
    let metadata = current_metadata(index);
    if !metadata.keeps_history() {
        return store.remove_history_files(&index.name);
    }
    let synced = sync_limits(&metadata, &index.name, store);
    let captured = changes_limits(&metadata, &index.name, store)?;
    let limits = match (&synced, captured) {
        (Some(synced), Some(captured)) => HistoryLimits {
            max_age_ms: synced.max_age_ms.max(captured.max_age_ms),
            max_bytes: synced.max_bytes.max(captured.max_bytes),
        },
        (Some(synced), None) => HistoryLimits { ..*synced },
        (None, Some(captured)) => captured,
        (None, None) => return Ok(()),
    };
    let mut publish_now = || publish(index, store);
    let publisher: Option<&mut dyn FnMut() -> Result<PublishedSnapshot>> = match synced {
        Some(_) => Some(&mut publish_now),
        None => None,
    };
    store.enforce_history(&index.name, &limits, now_ms(), publisher)?;
    Ok(())
}

/// Applies the history limits of every index whose checkpoint moved log segments into history since the last
/// pass, or of every index where `sweep` is set, reporting a failure as a `DurabilityError` event.
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
