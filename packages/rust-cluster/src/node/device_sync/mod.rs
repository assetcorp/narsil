mod feeds;
mod settings;
mod snapshots;

pub use snapshots::{ClusterDocumentExport, ClusterSyncSnapshot};

use narsil::{
    ChangesSetting, ChangesStatus, Map, SyncSetting, SyncStatus, Value, decode_msgpack,
    encode_msgpack,
};

use self::settings::{
    SYNC_FIELDS, changes_status_of, next_changes_settings, next_sync_settings, require_limit,
    sync_status_of,
};
use super::handle::ClusterNode;
use crate::constants::{HIDDEN_GENERATION_PREFIX, MAX_SETTINGS_REPLACEMENT_ATTEMPTS};
use crate::controller::{metadata_key, validate_index_name};
use crate::data::{
    CHANGE_CAPTURE_READINESS, DEVICE_SYNC_READINESS, Readiness, nodes_below, not_ready,
};
use crate::error::{ClusterError, ClusterResult, codes};

const SETTINGS_CONTENTION_REASON: &str = "settings_contention";
const DEFAULT_LANGUAGE: &str = "english";

struct Snapshot {
    bytes: Vec<u8>,
    fields: Map,
    settings: Map,
}

fn index_not_found(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' does not exist in the cluster"),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn refuse_hidden_generation(index_name: &str) -> ClusterResult<()> {
    if !index_name.starts_with(HIDDEN_GENERATION_PREFIX) {
        return validate_index_name(index_name);
    }
    Err(ClusterError::new(
        codes::CONFIG_INVALID,
        format!("Index names that start with '{HIDDEN_GENERATION_PREFIX}' are reserved for partition count changes"),
    )
    .with_detail("indexName", Value::from(index_name)))
}

fn metadata_unreadable(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::CONTROLLER_METADATA_INVALID,
        format!("Index metadata for '{index_name}' is not a MessagePack map"),
    )
    .with_detail("indexName", Value::from(index_name))
}

impl ClusterNode {
    async fn metadata_snapshot(&self, index_name: &str) -> ClusterResult<Snapshot> {
        let coordinator = &self.inner.coordinator;
        let Some(bytes) = coordinator.get(&metadata_key(index_name)).await? else {
            return Err(index_not_found(index_name));
        };
        if bytes.is_empty() {
            return Err(index_not_found(index_name));
        }
        let Ok(Value::Object(fields)) = decode_msgpack(&bytes) else {
            return Err(metadata_unreadable(index_name));
        };
        let settings = match fields.get("settings") {
            Some(Value::Object(settings)) => settings.clone(),
            _ => Map::new(),
        };
        Ok(Snapshot {
            bytes,
            fields,
            settings,
        })
    }

    async fn require_ready(&self, readiness: &Readiness, index_name: &str) -> ClusterResult<()> {
        let older = nodes_below(&self.inner.coordinator, readiness.minimum).await?;
        if older.is_empty() {
            return Ok(());
        }
        Err(not_ready(readiness, older, index_name))
    }

    async fn replace_sync_fields(
        &self,
        index_name: &str,
        what: &str,
        next_of: impl Fn(&Map) -> ClusterResult<Option<Map>>,
        check: impl Fn(&Map) -> ClusterResult<()>,
    ) -> ClusterResult<()> {
        for _ in 0..MAX_SETTINGS_REPLACEMENT_ATTEMPTS {
            let snapshot = self.metadata_snapshot(index_name).await?;
            check(&snapshot.settings)?;
            let Some(next) = next_of(&snapshot.settings)? else {
                return Ok(());
            };
            let mut settings = snapshot.settings.clone();
            if !matches!(snapshot.fields.get("settings"), Some(Value::Object(_))) {
                settings.insert("language", Value::from(DEFAULT_LANGUAGE));
            }
            for field in SYNC_FIELDS {
                settings.remove(field);
            }
            for (field, value) in next.iter() {
                settings.insert(field.clone(), value.clone());
            }
            let mut fields = snapshot.fields.clone();
            fields.insert("settings", Value::Object(settings));
            let encoded = encode_msgpack(&Value::Object(fields)).map_err(ClusterError::from)?;
            let key = metadata_key(index_name);
            if self
                .inner
                .coordinator
                .compare_and_set(&key, Some(&snapshot.bytes), &encoded)
                .await?
            {
                if let Some(data) = &self.inner.data {
                    data.refresh_device_sync(index_name).await?;
                }
                return Ok(());
            }
        }
        Err(ClusterError::new(
            codes::CLUSTER_WRITE_BLOCKED,
            format!(
                "Index '{index_name}' kept changing while its {what} setting was replaced {MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so the new setting was not stored. Retry the request"
            ),
        )
        .with_detail("reason", Value::from(SETTINGS_CONTENTION_REASON))
        .with_detail("indexName", Value::from(index_name))
        .with_detail("attempts", Value::from(MAX_SETTINGS_REPLACEMENT_ATTEMPTS)))
    }

    fn has_sync_durability(&self) -> bool {
        self.inner
            .data
            .as_ref()
            .is_some_and(|data| data.keeps_write_ahead_log())
    }
}

impl ClusterNode {
    /// Turns device sync on or off for a cluster index, or changes its history limits, by replacing the sync fields
    /// of the index's settings in etcd, which every node that holds a copy then adopts.
    ///
    /// Turning sync on gives the index a new epoch, unless change capture keeps one, and turning it off keeps the
    /// epoch only while change capture is on.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the name is reserved or malformed, where a history limit is not a positive
    /// whole number, or where sync would go on while the index has popular query suggestions on, with
    /// `SYNC_DURABILITY_REQUIRED` where sync would go on through a node without a write-ahead log, with
    /// `SYNC_BACKUP_STORE_REQUIRED` where sync would go on through a node without a backup store, with
    /// `SYNC_NOT_READY` where a registered node follows a specification version below 1.3, with `INDEX_NOT_FOUND`
    /// where the cluster holds no such index, and with `CLUSTER_WRITE_BLOCKED` where the index's metadata kept
    /// changing through five attempts.
    pub async fn update_sync(&self, index_name: &str, setting: &SyncSetting) -> ClusterResult<()> {
        refuse_hidden_generation(index_name)?;
        require_limit("sync", "historyMaxAgeMs", setting.history_max_age_ms)?;
        require_limit("sync", "historyMaxBytes", setting.history_max_bytes)?;
        if setting.enabled {
            if !self.has_sync_durability() {
                return Err(ClusterError::new(
                    codes::SYNC_DURABILITY_REQUIRED,
                    format!("Index \"{index_name}\" needs write-ahead log durability on every node for device sync, because the feed reads the log"),
                )
                .with_detail("indexName", Value::from(index_name)));
            }
            if !self.inner.has_backup_store() {
                return Err(ClusterError::new(
                    codes::SYNC_BACKUP_STORE_REQUIRED,
                    "Device sync in a cluster needs a backup store, because a cluster node takes a device's first copy from a backup",
                )
                .with_detail("indexName", Value::from(index_name)));
            }
            self.require_ready(&DEVICE_SYNC_READINESS, index_name)
                .await?;
        }
        let enabling = setting.enabled;
        self.replace_sync_fields(
            index_name,
            "sync",
            |current| next_sync_settings(current, setting),
            |current| {
                let suggesting = matches!(current.get("querySuggestions"), Some(Value::Object(fields)) if fields.get("enabled") == Some(&Value::Bool(true)));
                if enabling && suggesting {
                    return Err(ClusterError::new(
                        codes::CONFIG_INVALID,
                        format!("Index \"{index_name}\" has popular query suggestions on, so it cannot sync to devices: a device receives the whole index of one user, while a suggestion comes from the searches of several people"),
                    )
                    .with_detail("indexName", Value::from(index_name)));
                }
                Ok(())
            },
        )
        .await
    }

    /// Returns the device sync state of a cluster index as its settings in etcd hold it.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the name is reserved or malformed, and with `INDEX_NOT_FOUND` where the
    /// cluster holds no such index.
    pub async fn get_sync(&self, index_name: &str) -> ClusterResult<SyncStatus> {
        refuse_hidden_generation(index_name)?;
        Ok(sync_status_of(
            &self.metadata_snapshot(index_name).await?.settings,
        ))
    }

    /// Turns change capture on or off for a cluster index, or changes its settings, by replacing the change
    /// capture fields of the index's settings in etcd, which every node that holds a copy then adopts.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::update_sync`] does, with `CHANGES_DURABILITY_REQUIRED`,
    /// `CHANGES_BACKUP_STORE_REQUIRED`, and `CHANGES_NOT_READY` in place of the sync codes, where the minimum
    /// specification version is 1.5.
    pub async fn update_changes(
        &self,
        index_name: &str,
        setting: &ChangesSetting,
    ) -> ClusterResult<()> {
        refuse_hidden_generation(index_name)?;
        require_limit("changes", "historyMaxAgeMs", setting.history_max_age_ms)?;
        require_limit("changes", "historyMaxBytes", setting.history_max_bytes)?;
        if setting.enabled {
            if !self.has_sync_durability() {
                return Err(ClusterError::new(
                    codes::CHANGES_DURABILITY_REQUIRED,
                    format!("Index \"{index_name}\" needs write-ahead log durability on every node for change capture, because the feed reads the log"),
                )
                .with_detail("indexName", Value::from(index_name)));
            }
            if !self.inner.has_backup_store() {
                return Err(ClusterError::new(
                    codes::CHANGES_BACKUP_STORE_REQUIRED,
                    "Change capture in a cluster needs a backup store, because a cluster node builds a document export from a backup",
                )
                .with_detail("indexName", Value::from(index_name)));
            }
            self.require_ready(&CHANGE_CAPTURE_READINESS, index_name)
                .await?;
        }
        self.replace_sync_fields(
            index_name,
            "changes",
            |current| next_changes_settings(current, setting),
            |_| Ok(()),
        )
        .await
    }

    /// Returns the change capture state of a cluster index as its settings in etcd hold it.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::get_sync`] does.
    pub async fn get_changes(&self, index_name: &str) -> ClusterResult<ChangesStatus> {
        refuse_hidden_generation(index_name)?;
        Ok(changes_status_of(
            &self.metadata_snapshot(index_name).await?.settings,
        ))
    }
}
