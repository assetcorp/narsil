use super::PartitionCopies;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::format::metadata_parts::{
    ChangesSetting as StoredChangesSetting, SyncSetting as StoredSyncSetting,
};
use crate::value::Value;

/// The device sync state that a cluster gives one copy, with the epoch that every copy of the index shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopySyncState {
    /// The history age limit in milliseconds, if the cluster's setting gives one.
    pub history_max_age_ms: Option<u64>,
    /// The history byte limit, if the cluster's setting gives one.
    pub history_max_bytes: Option<u64>,
    /// Whether a device has asked the cluster for the published snapshot.
    pub active: bool,
    /// The index epoch as 32 lowercase hexadecimal digits.
    pub epoch: String,
}

/// The change capture state that a cluster gives one copy, with the epoch that every copy of the index shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyChangesState {
    /// Whether each log entry holds the document that it replaces or removes.
    pub previous_document: bool,
    /// The history age limit in milliseconds, if the cluster's setting gives one.
    pub history_max_age_ms: Option<u64>,
    /// The history byte limit, if the cluster's setting gives one.
    pub history_max_bytes: Option<u64>,
    /// The index epoch as 32 lowercase hexadecimal digits.
    pub epoch: String,
}

/// The device sync and change capture states that a copy keeps, where `None` turns that feature off.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CopyEpochStates {
    /// The device sync state, or `None` while device sync is off.
    pub sync: Option<CopySyncState>,
    /// The change capture state, or `None` while change capture is off.
    pub changes: Option<CopyChangesState>,
}

fn held_states(metadata: &IndexMetadata) -> CopyEpochStates {
    let epoch = metadata.sync_epoch.clone();
    let sync = match (&metadata.sync, &epoch) {
        (Some(sync), Some(epoch)) if sync.enabled => Some(CopySyncState {
            history_max_age_ms: sync.history_max_age_ms,
            history_max_bytes: sync.history_max_bytes,
            active: metadata.sync_active == Some(true),
            epoch: epoch.clone(),
        }),
        _ => None,
    };
    let changes = match (&metadata.changes, &epoch) {
        (Some(changes), Some(epoch)) if changes.enabled => Some(CopyChangesState {
            previous_document: changes.records_previous_documents(),
            history_max_age_ms: changes.history_max_age_ms,
            history_max_bytes: changes.history_max_bytes,
            epoch: epoch.clone(),
        }),
        _ => None,
    };
    CopyEpochStates { sync, changes }
}

fn epoch_of(states: &CopyEpochStates) -> Option<&str> {
    states
        .sync
        .as_ref()
        .map(|sync| sync.epoch.as_str())
        .or_else(|| {
            states
                .changes
                .as_ref()
                .map(|changes| changes.epoch.as_str())
        })
}

fn require_epoch(epoch: Option<&str>) -> Result<()> {
    match epoch {
        Some(epoch) if !crate::format::metadata_parts::is_sync_epoch(epoch) => {
            Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                "A copy's epoch must be 32 lowercase hexadecimal digits",
            )
            .with_details([("epoch", Value::from(epoch))]))
        }
        _ => Ok(()),
    }
}

fn adopt(metadata: &mut IndexMetadata, next: &CopyEpochStates) {
    metadata.sync = next.sync.as_ref().map(|sync| StoredSyncSetting {
        enabled: true,
        history_max_age_ms: sync.history_max_age_ms,
        history_max_bytes: sync.history_max_bytes,
    });
    metadata.sync_active = next.sync.as_ref().map(|sync| sync.active);
    metadata.changes = next.changes.as_ref().map(|changes| StoredChangesSetting {
        enabled: true,
        previous_document: changes.previous_document.then_some(true),
        history_max_age_ms: changes.history_max_age_ms,
        history_max_bytes: changes.history_max_bytes,
    });
    metadata.sync_epoch = epoch_of(next).map(str::to_string);
}

fn release(index: &IndexState, with_history: bool) -> Result<()> {
    match index.log().and_then(|log| log.log_store()) {
        Some(store) => store.release_sync_files(&index.name, with_history),
        None => Ok(()),
    }
}

impl PartitionCopies<'_> {
    /// Gives a copy the device sync and change capture states that the cluster's settings hold, and reports
    /// whether the copy's states changed.
    ///
    /// The copy keeps the epoch that the cluster gives it, so its history and published snapshot match every other
    /// copy's. Where the epoch changes, the engine deletes the copy's published snapshot and history first, and where
    /// device sync goes off, it deletes the published snapshot, and the history too unless change capture keeps it.
    /// A copy without write-ahead log durability records nothing and reports no change.
    ///
    /// Fails with `CONFIG_INVALID` where an epoch is not 32 lowercase hexadecimal digits.
    pub fn adopt_epoch_states(&self, index: &str, next: &CopyEpochStates) -> Result<bool> {
        require_epoch(next.sync.as_ref().map(|sync| sync.epoch.as_str()))?;
        require_epoch(next.changes.as_ref().map(|changes| changes.epoch.as_str()))?;
        let state = match self.engine.open_index(index) {
            Ok(state) => state,
            Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => return Ok(false),
            Err(error) => return Err(error),
        };
        let _writer = state.lock_writes()?;
        let Some(log) = state.log() else {
            return Ok(false);
        };
        let mut metadata = log.metadata(&state);
        let held = held_states(&metadata);
        if held == *next {
            return Ok(false);
        }
        let (held_epoch, next_epoch) = (epoch_of(&held), epoch_of(next));
        if held_epoch.is_some() && next_epoch.is_some() && held_epoch != next_epoch {
            release(&state, true)?;
        }
        adopt(&mut metadata, next);
        log.write_recorded(metadata)?;
        if next.sync.is_none() && held.sync.is_some() {
            release(&state, next.changes.is_none())?;
        } else if next_epoch.is_none() && held_epoch.is_some() {
            release(&state, true)?;
        }
        Ok(true)
    }
}
