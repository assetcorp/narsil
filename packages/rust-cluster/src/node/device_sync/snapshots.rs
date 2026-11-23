use std::io::Write;
use std::sync::Arc;

use narsil::Value;
use narsil::replication::BackupFileReader;

use super::settings::{next_active_settings, require_sync_on};
use super::{ClusterNode, refuse_hidden_generation};
use crate::backups::{CHANGES_BACKUP_TAKER, SYNC_BACKUP_TAKER};
use crate::constants::{CHANGES_EXPORT_RETRY_AFTER_MS, DEVICE_SYNC_SNAPSHOT_RETRY_AFTER_MS};
use crate::data::SpooledArchive;
use crate::error::{ClusterError, ClusterResult, codes};

/// The first copy of a cluster index that a device downloads, laid out as a snapshot archive from the newest backup
/// that the index's sync history still covers.
pub struct ClusterSyncSnapshot {
    archive: Arc<SpooledArchive>,
    read: BackupFileReader,
}

impl ClusterSyncSnapshot {
    /// Returns the entity tag of the snapshot, which changes whenever the cluster serves the index from another
    /// backup, so that a device resumes a download only while the tag holds.
    pub fn entity_tag(&self) -> &str {
        &self.archive.entity_tag
    }

    /// Returns the length in bytes of the snapshot archive.
    pub fn byte_length(&self) -> u64 {
        self.archive.archive.byte_length()
    }

    /// Copies the bytes of the snapshot archive from `offset` into `buffer`, and returns how many it copied, which
    /// is fewer than the buffer holds only at the end of the archive.
    ///
    /// # Errors
    ///
    /// Fails with `PERSISTENCE_LOAD_FAILED` where a spooled backup file cannot be read or is shorter than listed.
    pub fn read_at(&self, offset: u64, buffer: &mut [u8]) -> narsil::Result<usize> {
        self.archive.archive.read_at(offset, buffer, &self.read)
    }
}

/// The document export of a cluster index, built from the newest backup that the index's change history still
/// covers.
pub struct ClusterDocumentExport {
    archive: Arc<SpooledArchive>,
    epoch: String,
}

impl ClusterDocumentExport {
    /// Writes the document export to `out`, with the index's epoch in its header and each partition's backed-up
    /// sequence number as the position that a change feed resumes from.
    ///
    /// # Errors
    ///
    /// Fails with `PERSISTENCE_LOAD_FAILED` where a spooled backup file cannot be read, with an envelope error where
    /// the backup's configuration is damaged, and with `PERSISTENCE_SAVE_FAILED` where `out` refuses a write.
    pub fn write_to(&self, out: &mut dyn Write) -> narsil::Result<()> {
        self.archive
            .archive
            .write_document_export(&self.epoch, self.archive.reader(), out)
    }
}

fn sync_off(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::SYNC_NOT_ENABLED,
        format!("Index \"{index_name}\" has device sync off"),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn preparing(code: &str, message: String, index_name: &str, retry_after_ms: u64) -> ClusterError {
    ClusterError::new(code, message)
        .with_detail("indexName", Value::from(index_name))
        .with_detail("retryAfterMs", Value::from(retry_after_ms))
}

fn export_unsupported(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::CLUSTER_OPERATION_UNSUPPORTED,
        format!("A cluster node exports the documents of an index only while change capture is on, and index \"{index_name}\" has it off"),
    )
    .with_detail("operation", Value::from("exportDocuments"))
    .with_detail("indexName", Value::from(index_name))
}

impl ClusterNode {
    async fn mark_sync_active(&self, index_name: &str) -> ClusterResult<()> {
        self.replace_sync_fields(
            index_name,
            "sync",
            |current| Ok(next_active_settings(current)),
            |current| require_sync_on(index_name, current),
        )
        .await
    }

    /// Returns the snapshot that a device downloads as its first copy of a cluster index, merged from the newest
    /// backup that the index's sync history still covers, and marks the index's sync active.
    ///
    /// Where no backup qualifies, the node asks the controller for one and fails with `SYNC_SNAPSHOT_PREPARING`,
    /// whose `retryAfterMs` detail tells the device when to ask again.
    ///
    /// # Errors
    ///
    /// Fails with `SYNC_NOT_ENABLED` where the index has device sync off, with `SYNC_BACKUP_STORE_REQUIRED` where the
    /// node has no backup store, with `SYNC_SNAPSHOT_PREPARING` while the backup is taken, and with `BACKUP_DAMAGED`
    /// where a stored file fails its check.
    pub async fn sync_snapshot(&self, index_name: &str) -> ClusterResult<ClusterSyncSnapshot> {
        let view = self.inner.device_sync.view().await?;
        let mut held = view.current(index_name).await?;
        let Some(state) = held.as_ref().and_then(|held| held.states.sync.clone()) else {
            return Err(sync_off(index_name));
        };
        if !state.active {
            self.mark_sync_active(index_name).await?;
            held = view.held(index_name).or(held);
        }
        let Some(held) = held else {
            return Err(sync_off(index_name));
        };
        let Some(store) = self.inner.backups.store() else {
            return Err(ClusterError::new(
                codes::SYNC_BACKUP_STORE_REQUIRED,
                "Device sync in a cluster needs a backup store, because a cluster node takes a device's first copy from a backup",
            )
            .with_detail("indexName", Value::from(index_name)));
        };
        let snapshots = self.inner.device_sync.snapshots();
        let partition_count = held.serving.partition_count;
        let qualifying = snapshots
            .qualifying(store, index_name, partition_count, &state.epoch)
            .await?;
        let Some(backup) = qualifying else {
            snapshots
                .start_backup(&self.inner.backups.requests, index_name, SYNC_BACKUP_TAKER)
                .await?;
            return Err(preparing(
                codes::SYNC_SNAPSHOT_PREPARING,
                format!(
                    "The cluster is taking the backup that the snapshot of index \"{index_name}\" needs. Ask again later"
                ),
                index_name,
                DEVICE_SYNC_SNAPSHOT_RETRY_AFTER_MS,
            ));
        };
        let archive = snapshots.acquire(store, index_name, &backup).await?;
        let read = archive.reader();
        Ok(ClusterSyncSnapshot { archive, read })
    }

    /// Returns the document export of a cluster index, built from the newest backup that the index's change history
    /// still covers, so that a reader can load the documents and follow the change feed from the export's positions.
    ///
    /// Where no backup qualifies, the node asks the controller for one and fails with `CHANGES_EXPORT_PREPARING`,
    /// whose `retryAfterMs` detail tells the caller when to ask again.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the name is reserved or malformed, with `CLUSTER_OPERATION_UNSUPPORTED` where
    /// the index has change capture off, with `CHANGES_BACKUP_STORE_REQUIRED` where the node has no backup store,
    /// with `CHANGES_EXPORT_PREPARING` while the backup is taken, and with `BACKUP_DAMAGED` where a stored file fails
    /// its check.
    pub async fn export_documents(&self, index_name: &str) -> ClusterResult<ClusterDocumentExport> {
        refuse_hidden_generation(index_name)?;
        let view = self.inner.device_sync.view().await?;
        let held = view.current(index_name).await?;
        let Some((held, state)) = held.and_then(|held| {
            let state = held.states.changes.clone()?;
            Some((held, state))
        }) else {
            return Err(export_unsupported(index_name));
        };
        let Some(store) = self.inner.backups.store() else {
            return Err(ClusterError::new(
                codes::CHANGES_BACKUP_STORE_REQUIRED,
                "Change capture in a cluster needs a backup store, because a cluster node builds a document export from a backup",
            )
            .with_detail("indexName", Value::from(index_name)));
        };
        let snapshots = self.inner.device_sync.snapshots();
        let partition_count = held.serving.partition_count;
        let qualifying = snapshots
            .qualifying(store, index_name, partition_count, &state.epoch)
            .await?;
        let Some(backup) = qualifying else {
            snapshots
                .start_backup(
                    &self.inner.backups.requests,
                    index_name,
                    CHANGES_BACKUP_TAKER,
                )
                .await?;
            return Err(preparing(
                codes::CHANGES_EXPORT_PREPARING,
                format!(
                    "The cluster is taking the backup that the export of index \"{index_name}\" needs. Ask again later"
                ),
                index_name,
                CHANGES_EXPORT_RETRY_AFTER_MS,
            ));
        };
        let archive = snapshots.acquire(store, index_name, &backup).await?;
        Ok(ClusterDocumentExport {
            archive,
            epoch: state.epoch,
        })
    }
}
