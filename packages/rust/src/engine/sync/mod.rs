pub(crate) mod constants;
pub(crate) mod retention;

use std::sync::Arc;

use super::Narsil;
use super::index::IndexState;
use crate::durability::store::DurabilityStore;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::format::metadata_parts::SyncSetting as StoredSyncSetting;
use crate::value::Value;
use constants::{MAX_SYNC_LIMIT, SYNC_EPOCH_BYTES};

/// The device sync setting of one index, which [`Narsil::update_sync`] takes.
///
/// Turn sync on only for an index whose every document belongs to one user, because every device that syncs the
/// index receives the whole index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSetting {
    /// Turns sync on or off. Turning it on gives the index a new epoch, so every synced device loads a new copy,
    /// unless change capture is on, which keeps the epoch that its subscribers follow.
    pub enabled: bool,
    /// The age in milliseconds after which the engine deletes a log segment from history, 30 days where unset.
    pub history_max_age_ms: Option<u64>,
    /// The byte count above which the engine deletes the oldest log segment from history, the length of the
    /// published snapshot where unset.
    pub history_max_bytes: Option<u64>,
}

/// The device sync state of one index, which [`Narsil::get_sync`] returns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncStatus {
    /// Whether sync is on for the index.
    pub enabled: bool,
    /// The history age limit in milliseconds that the setting gives, if any.
    pub history_max_age_ms: Option<u64>,
    /// The history byte limit that the setting gives, if any.
    pub history_max_bytes: Option<u64>,
    /// Whether a device has asked for the published snapshot, from when the engine keeps history.
    pub active: bool,
    /// The index epoch as 32 lowercase hexadecimal digits, or `None` while sync is off.
    pub epoch: Option<String>,
}

/// Reports whether the metadata of an index turns device sync on.
pub(crate) fn sync_is_on(metadata: &IndexMetadata) -> bool {
    metadata.syncs_devices()
}

/// Returns the epoch of an index while device sync or change capture is on, which the two features share.
pub(crate) fn sync_epoch_of(metadata: &IndexMetadata) -> Option<&str> {
    metadata
        .keeps_epoch()
        .then_some(metadata.sync_epoch.as_deref())
        .flatten()
}

pub(crate) fn new_sync_epoch() -> Result<String> {
    let mut bytes = [0u8; SYNC_EPOCH_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!("The engine could not read random bytes for an index epoch: {error}"),
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Clears the device sync fields of `metadata`, keeping the epoch while change capture is on.
pub(crate) fn clear_sync(metadata: &mut IndexMetadata) {
    metadata.sync = None;
    metadata.sync_active = None;
    if !metadata.captures_changes() {
        metadata.sync_epoch = None;
    }
}

/// Brings the stored sync and change capture state of a recovered index to the form that the engine keeps: no
/// field of a feature that is off, and an epoch while either one is on. Returns whether the state changed, which
/// the engine then records.
pub(crate) fn settle_recovered_sync(metadata: &mut IndexMetadata) -> Result<bool> {
    let mut changed = false;
    if metadata.changes.is_some() && !metadata.captures_changes() {
        metadata.changes = None;
        changed = true;
    }
    if !sync_is_on(metadata) {
        changed |= metadata.sync.is_some() || metadata.sync_active.is_some();
        metadata.sync = None;
        metadata.sync_active = None;
    }
    if !metadata.keeps_epoch() {
        changed |= metadata.sync_epoch.is_some();
        metadata.sync_epoch = None;
        return Ok(changed);
    }
    if metadata.sync_epoch.is_some() {
        return Ok(changed);
    }
    if sync_is_on(metadata) {
        metadata.sync_active = Some(false);
    }
    metadata.sync_epoch = Some(new_sync_epoch()?);
    Ok(true)
}

/// Gives an index whose sync or change capture is on a new epoch that no device has asked for yet, and returns
/// whether it did, so that the caller releases the published snapshot and the history once the new metadata is
/// durable.
pub(crate) fn renew_sync_epoch(metadata: &mut IndexMetadata) -> Result<bool> {
    if !metadata.keeps_epoch() {
        return Ok(false);
    }
    if sync_is_on(metadata) {
        metadata.sync_active = Some(false);
    }
    metadata.sync_epoch = Some(new_sync_epoch()?);
    Ok(true)
}

/// Carries the sync and change capture settings of the index that a restore replaces onto the restored metadata,
/// with a new epoch.
pub(crate) fn carry_sync_onto(
    restored: &mut IndexMetadata,
    previous: &IndexMetadata,
) -> Result<bool> {
    restored.changes = None;
    clear_sync(restored);
    if sync_is_on(previous) {
        restored.sync = previous.sync;
    }
    if previous.captures_changes() {
        restored.changes = previous.changes;
    }
    renew_sync_epoch(restored)
}

/// Deletes the published snapshot and the history of a durable index under the write-ahead log tier.
pub(crate) fn release_sync(index: &IndexState) -> Result<()> {
    match index.log().and_then(|log| log.log_store()) {
        Some(store) => store.release_sync_files(&index.name, true),
        None => Ok(()),
    }
}

/// Deletes what the feeds of an index no longer need once its metadata reads `metadata`: the published snapshot
/// while device sync is off, and the history while neither feature keeps one.
pub(crate) fn release_unneeded(
    store: &DurabilityStore,
    index_name: &str,
    metadata: &IndexMetadata,
) -> Result<()> {
    if sync_is_on(metadata) && metadata.keeps_history() {
        return Ok(());
    }
    if !sync_is_on(metadata) {
        return store.release_sync_files(index_name, !metadata.keeps_history());
    }
    store.remove_history_files(index_name)
}

/// Gives an index with sync or change capture on a new epoch before a change that every device and every
/// subscriber has to load whole, such as a clear, while the caller holds the index's write lock: the engine records
/// the epoch, then releases the published snapshot and the history.
pub(crate) fn renew_epoch_locked(index: &IndexState) -> Result<()> {
    let Some(log) = index.log() else {
        return Ok(());
    };
    let mut metadata = log.metadata(index);
    if !renew_sync_epoch(&mut metadata)? {
        return Ok(());
    }
    log.write_recorded(metadata)?;
    release_sync(index)
}

/// Refuses a history limit of zero or above the largest whole number that every engine stores exactly.
pub(crate) fn require_limit(feature: &str, name: &str, value: Option<u64>) -> Result<()> {
    match value {
        Some(limit) if limit == 0 || limit > MAX_SYNC_LIMIT => Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!("The {feature} setting {name} must be a positive whole number"),
        )),
        _ => Ok(()),
    }
}

fn log_store_of(index: &IndexState) -> Result<Arc<DurabilityStore>> {
    index
        .log()
        .and_then(|log| log.log_store())
        .cloned()
        .ok_or_else(|| {
            NarsilError::new(
                ErrorCode::SYNC_DURABILITY_REQUIRED,
                format!(
                    "Index \"{}\" needs write-ahead log durability for device sync, because the feed reads the log",
                    index.name
                ),
            )
        })
}

fn require_no_query_suggestions(metadata: &IndexMetadata, index_name: &str) -> Result<()> {
    let enabled = matches!(
        &metadata.query_suggestions,
        Some(Value::Object(setting)) if matches!(setting.get("enabled"), Some(Value::Bool(true)))
    );
    if !enabled {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!(
            "Index \"{index_name}\" has popular query suggestions on, so it cannot sync to devices: a device receives the whole index of one user, while a suggestion comes from the searches of several people"
        ),
    ))
}

fn apply_setting(index: &IndexState, store: &DurabilityStore, setting: &SyncSetting) -> Result<()> {
    let _writer = index.lock_writes()?;
    let Some(log) = index.log() else {
        return Ok(());
    };
    let mut metadata = log.metadata(index);
    if setting.enabled {
        require_no_query_suggestions(&metadata, &index.name)?;
    }
    let was_on = sync_is_on(&metadata);
    if !setting.enabled {
        if !was_on {
            return Ok(());
        }
        clear_sync(&mut metadata);
        log.write_recorded(metadata.clone())?;
        return release_unneeded(store, &index.name, &metadata);
    }
    let kept_epoch = metadata.captures_changes();
    metadata.sync = Some(StoredSyncSetting {
        enabled: true,
        history_max_age_ms: setting.history_max_age_ms,
        history_max_bytes: setting.history_max_bytes,
    });
    if !was_on {
        store.release_sync_files(&index.name, !kept_epoch)?;
        metadata.sync_active = Some(false);
        if !kept_epoch || metadata.sync_epoch.is_none() {
            metadata.sync_epoch = Some(new_sync_epoch()?);
        }
    }
    log.write_recorded(metadata)
}

fn status_of(metadata: &IndexMetadata) -> SyncStatus {
    match (&metadata.sync, sync_epoch_of(metadata)) {
        (Some(sync), Some(epoch)) if sync.enabled => SyncStatus {
            enabled: true,
            history_max_age_ms: sync.history_max_age_ms,
            history_max_bytes: sync.history_max_bytes,
            active: metadata.sync_active == Some(true),
            epoch: Some(epoch.to_string()),
        },
        _ => SyncStatus::default(),
    }
}

impl Narsil {
    /// Replaces the device sync setting of an index.
    ///
    /// Turning sync on gives the index a new epoch, except while change capture is on, and changing a history
    /// limit while sync is on keeps the epoch. Turning sync off deletes the published snapshot, and the history too
    /// unless change capture keeps it. The engine saves the setting with the index, so it stays in place after a
    /// restart, and no snapshot of the index includes it.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, with `CONFIG_INVALID` where a
    /// history limit is not a positive whole number or where sync would go on while the index has popular query
    /// suggestions on, and with `SYNC_DURABILITY_REQUIRED` where the engine has no write-ahead log durability.
    pub fn update_sync(&self, index: &str, setting: &SyncSetting) -> Result<()> {
        self.inner.open_index(index)?;
        require_limit("sync", "historyMaxAgeMs", setting.history_max_age_ms)?;
        require_limit("sync", "historyMaxBytes", setting.history_max_bytes)?;
        let (_name, state) = self.inner.open_index_in_turn(index)?;
        let store = log_store_of(&state)?;
        apply_setting(&state, &store, setting)
    }

    /// Returns the device sync state of an index: its setting, whether a device has asked for the published
    /// snapshot, and its epoch.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`.
    pub fn get_sync(&self, index: &str) -> Result<SyncStatus> {
        let state = self.inner.open_index(index)?;
        Ok(match state.log() {
            Some(log) => status_of(&log.metadata(&state)),
            None => SyncStatus::default(),
        })
    }
}
