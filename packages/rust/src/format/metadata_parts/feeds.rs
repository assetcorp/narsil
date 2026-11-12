use super::changes::{changes_from_wire, changes_to_wire};
use super::sync::{sync_from_wire, sync_to_wire};
use super::{config_invalid, is_sync_epoch};
use crate::error::Result;
use crate::format::metadata::IndexMetadata;
use crate::value::{Map, Value};

impl IndexMetadata {
    /// Reports whether the metadata turns device sync on.
    pub(crate) fn syncs_devices(&self) -> bool {
        self.sync.as_ref().is_some_and(|sync| sync.enabled)
    }

    /// Reports whether the metadata turns change capture on.
    pub(crate) fn captures_changes(&self) -> bool {
        self.changes.as_ref().is_some_and(|changes| changes.enabled)
    }

    /// Reports whether each log entry of the index holds the document that it replaces or removes.
    pub(crate) fn records_previous_documents(&self) -> bool {
        self.changes
            .as_ref()
            .is_some_and(|changes| changes.records_previous_documents())
    }

    /// Reports whether the index keeps an epoch, which it does while device sync or change capture is on.
    pub(crate) fn keeps_epoch(&self) -> bool {
        self.syncs_devices() || self.captures_changes()
    }

    /// Reports whether a device has asked for the published snapshot of a synced index.
    pub(crate) fn sync_is_active(&self) -> bool {
        self.syncs_devices() && self.sync_active == Some(true)
    }

    /// Reports whether a checkpoint moves each covered log segment into history, which it does while device sync is
    /// active or change capture is on.
    pub(crate) fn keeps_history(&self) -> bool {
        self.sync_is_active() || self.captures_changes()
    }
}

/// Reads the device sync and change capture fields of an index metadata map into `meta`.
pub(crate) fn feeds_from_wire(raw: &Map, meta: &mut IndexMetadata) -> Result<()> {
    if let Some(sync) = raw.get("sync").filter(|value| !value.is_null()) {
        meta.sync = Some(sync_from_wire(sync)?);
    }
    match raw.get("sync_active") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(active)) => meta.sync_active = Some(*active),
        Some(_) => {
            return Err(config_invalid(
                "The device sync state in the index metadata holds a sync_active that is not a boolean",
            ));
        }
    }
    match raw.get("sync_epoch") {
        None | Some(Value::Null) => {}
        Some(Value::String(epoch)) if is_sync_epoch(epoch) => meta.sync_epoch = Some(epoch.clone()),
        Some(_) => {
            return Err(config_invalid(
                "The device sync state in the index metadata holds an epoch that is not 32 lowercase hexadecimal digits",
            ));
        }
    }
    if let Some(changes) = raw.get("changes").filter(|value| !value.is_null()) {
        meta.changes = Some(changes_from_wire(changes)?);
    }
    Ok(())
}

/// Writes the device sync and change capture fields of `meta` into an index metadata map.
pub(crate) fn feeds_to_wire(meta: &IndexMetadata, wire: &mut Map) {
    if let Some(sync) = &meta.sync {
        wire.insert("sync", sync_to_wire(sync));
    }
    if let Some(active) = meta.sync_active {
        wire.insert("sync_active", Value::Bool(active));
    }
    if let Some(epoch) = &meta.sync_epoch {
        wire.insert("sync_epoch", Value::String(epoch.clone()));
    }
    if let Some(changes) = &meta.changes {
        wire.insert("changes", changes_to_wire(changes));
    }
}
