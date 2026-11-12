use std::sync::Arc;

use crate::durability::store::DurabilityStore;
use crate::engine::Narsil;
use crate::engine::index::IndexState;
use crate::engine::sync::{new_sync_epoch, require_limit};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::format::metadata_parts::ChangesSetting as StoredChangesSetting;

/// The change capture setting of one index, which [`Narsil::update_changes`] takes.
///
/// A subscriber receives the documents of the whole index, so decide which callers may follow an index before you
/// turn capture on. A filter only chooses which changes a subscriber receives, and it grants no access.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChangesSetting {
    /// Turns change capture on or off. Turning it on gives the index a new epoch, unless device sync is on.
    pub enabled: bool,
    /// Writes into each log entry the document that the entry replaces or removes, so that a change holds the
    /// document before the write and a subscription can hold a filter. Each update and removal then reads the
    /// stored document and writes it to the log again.
    pub previous_document: bool,
    /// The age in milliseconds after which the engine deletes a log segment from history, 30 days where unset.
    pub history_max_age_ms: Option<u64>,
    /// The byte count above which the engine deletes the oldest log segment from history, the larger of the
    /// checkpoint's length and 1 GiB where unset.
    pub history_max_bytes: Option<u64>,
}

/// The change capture state of one index, which [`Narsil::get_changes_setting`] returns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChangesStatus {
    /// Whether change capture is on for the index.
    pub enabled: bool,
    /// Whether each log entry holds the document before the write.
    pub previous_document: bool,
    /// The history age limit in milliseconds that the setting gives, if any.
    pub history_max_age_ms: Option<u64>,
    /// The history byte limit that the setting gives, if any.
    pub history_max_bytes: Option<u64>,
    /// The index epoch as 32 lowercase hexadecimal digits, or `None` while capture is off.
    pub epoch: Option<String>,
}

fn log_store_of(index: &IndexState) -> Result<Arc<DurabilityStore>> {
    index
        .log()
        .and_then(|log| log.log_store())
        .cloned()
        .ok_or_else(|| {
            NarsilError::new(
                ErrorCode::CHANGES_DURABILITY_REQUIRED,
                format!(
                    "Index \"{}\" needs write-ahead log durability for change capture, because the feed reads the log",
                    index.name
                ),
            )
        })
}

fn turn_off(
    index: &IndexState,
    store: &DurabilityStore,
    mut metadata: IndexMetadata,
) -> Result<()> {
    let Some(log) = index.log() else {
        return Ok(());
    };
    metadata.changes = None;
    if !metadata.syncs_devices() {
        metadata.sync_epoch = None;
    }
    log.write_recorded(metadata.clone())?;
    if metadata.keeps_history() {
        return Ok(());
    }
    store.remove_history_files(&index.name)
}

fn apply_setting(
    index: &IndexState,
    store: &DurabilityStore,
    setting: &ChangesSetting,
) -> Result<()> {
    let _writer = index.lock_writes()?;
    let Some(log) = index.log() else {
        return Ok(());
    };
    let mut metadata = log.metadata(index);
    let was_on = metadata.captures_changes();
    if !setting.enabled {
        if !was_on {
            return Ok(());
        }
        return turn_off(index, store, metadata);
    }
    metadata.changes = Some(StoredChangesSetting {
        enabled: true,
        previous_document: setting.previous_document.then_some(true),
        history_max_age_ms: setting.history_max_age_ms,
        history_max_bytes: setting.history_max_bytes,
    });
    let keeps_epoch = was_on || metadata.syncs_devices();
    if !keeps_epoch {
        store.release_sync_files(&index.name, true)?;
    }
    if !keeps_epoch || metadata.sync_epoch.is_none() {
        metadata.sync_epoch = Some(new_sync_epoch()?);
    }
    log.write_recorded(metadata)
}

fn status_of(metadata: &IndexMetadata) -> ChangesStatus {
    match (&metadata.changes, &metadata.sync_epoch) {
        (Some(changes), Some(epoch)) if changes.enabled => ChangesStatus {
            enabled: true,
            previous_document: changes.records_previous_documents(),
            history_max_age_ms: changes.history_max_age_ms,
            history_max_bytes: changes.history_max_bytes,
            epoch: Some(epoch.clone()),
        },
        _ => ChangesStatus::default(),
    }
}

impl Narsil {
    /// Replaces the change capture setting of an index.
    ///
    /// Turning capture on gives the index a new epoch unless device sync is on, and every checkpoint from then on
    /// keeps the log segments that it covers as history. Changing `previous_document` or a history limit keeps the
    /// epoch, and the new `previous_document` applies to every write after the call. Turning capture off ends every
    /// change feed of the index and deletes the history, unless a device has asked for the index's sync snapshot.
    /// The engine saves the setting with the index, so it stays in place after a restart, and no snapshot of the
    /// index includes it.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, with `CONFIG_INVALID` where a
    /// history limit is not a positive whole number, and with `CHANGES_DURABILITY_REQUIRED` where the engine has no
    /// write-ahead log durability.
    pub fn update_changes(&self, index: &str, setting: &ChangesSetting) -> Result<()> {
        self.inner.open_index(index)?;
        require_limit("changes", "historyMaxAgeMs", setting.history_max_age_ms)?;
        require_limit("changes", "historyMaxBytes", setting.history_max_bytes)?;
        let (_name, state) = self.inner.open_index_in_turn(index)?;
        let store = log_store_of(&state)?;
        apply_setting(&state, &store, setting)
    }

    /// Returns the change capture state of an index: its setting and its epoch.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`.
    pub fn get_changes_setting(&self, index: &str) -> Result<ChangesStatus> {
        let state = self.inner.open_index(index)?;
        Ok(match state.log() {
            Some(log) => status_of(&log.metadata(&state)),
            None => ChangesStatus::default(),
        })
    }
}
