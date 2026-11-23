use narsil::Value;

use super::handle::ClusterNode;
use super::member::Phase;
use crate::backups::{
    BackupListing, BackupProgressHandler, BackupSummary, CreateBackupOptions, RestoreBackupOptions,
    list_backups, request_backup, request_backup_deletion, request_restore, require_backup_store,
};
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};

impl ClusterNode {
    fn refuse_after_shutdown(&self) -> ClusterResult<()> {
        if *lock(&self.inner.phase) != Phase::Shutdown {
            return Ok(());
        }
        let node_id = self.node_id();
        Err(ClusterError::new(
            codes::NODE_NOT_JOINED,
            format!("Cluster node '{node_id}' has been shut down"),
        )
        .with_detail("nodeId", Value::from(node_id)))
    }

    /// Backs up every partition of `index_name` under `backup_name` in the cluster's backup store, and returns the
    /// summary of the stored backup once the controller has written its manifest.
    ///
    /// The backup holds every write that the cluster acknowledged before it started. Each partition's primary
    /// uploads that partition's files, and the backup stores a file only once across every backup that lists it.
    ///
    /// # Errors
    ///
    /// Fails with `BACKUP_STORE_NOT_CONFIGURED` where the node has no backup store, with `CONFIG_INVALID` for an
    /// invalid backup or index name, with `NODE_NOT_CONTROLLER` where no node holds the controller lease, with
    /// `INDEX_NOT_FOUND`, `BACKUP_ALREADY_EXISTS`, `BACKUP_IN_PROGRESS`, `BACKUP_NOT_READY`, or
    /// `BACKUP_STORE_CLAIMED` where the controller refuses the backup, and with the job's error where it fails.
    pub async fn create_backup(
        &self,
        index_name: &str,
        backup_name: &str,
        options: &CreateBackupOptions,
    ) -> ClusterResult<BackupSummary> {
        let guard = || self.refuse_after_shutdown();
        request_backup(
            &self.inner.backups.requests,
            &guard,
            index_name,
            backup_name,
            options,
        )
        .await
    }

    /// Restores the backup stored under `backup_name` as a new index under `options.index_name`, and returns the
    /// backup's summary once the restored index serves under that name.
    ///
    /// The cluster restores every partition into a hidden index first, and it gives the restored index its name
    /// only once every partition holds the backup's documents, so a failed restore leaves no index behind.
    ///
    /// # Errors
    ///
    /// Fails with `BACKUP_STORE_NOT_CONFIGURED` where the node has no backup store, with `CONFIG_INVALID` for an
    /// invalid backup name, index name, or placement, with `NODE_NOT_CONTROLLER` where no node holds the controller
    /// lease, with `BACKUP_NOT_FOUND` or `INDEX_ALREADY_EXISTS` where the controller refuses the restore, with
    /// `BACKUP_DAMAGED` where a stored file fails its check, and with the job's error where it fails.
    pub async fn restore_backup(
        &self,
        backup_name: &str,
        options: &RestoreBackupOptions,
    ) -> ClusterResult<BackupSummary> {
        let guard = || self.refuse_after_shutdown();
        request_restore(&self.inner.backups.requests, &guard, backup_name, options).await
    }

    /// Deletes the backup stored under `backup_name`, along with every stored file that no other backup lists.
    ///
    /// # Errors
    ///
    /// Fails with `BACKUP_STORE_NOT_CONFIGURED` where the node has no backup store, with `CONFIG_INVALID` for an
    /// invalid backup name, with `NODE_NOT_CONTROLLER` where no node holds the controller lease, with
    /// `BACKUP_NOT_FOUND` or `BACKUP_IN_PROGRESS` where the controller refuses the deletion, and with the job's
    /// error where it fails.
    pub async fn delete_backup(
        &self,
        backup_name: &str,
        on_progress: Option<&BackupProgressHandler>,
    ) -> ClusterResult<()> {
        let guard = || self.refuse_after_shutdown();
        request_backup_deletion(
            &self.inner.backups.requests,
            &guard,
            backup_name,
            on_progress,
        )
        .await
    }

    /// Returns every backup in the cluster's backup store, sorted by name, with a [`BackupListing::Damaged`] entry
    /// for each backup whose manifest cannot be read.
    ///
    /// # Errors
    ///
    /// Fails with `BACKUP_STORE_NOT_CONFIGURED` where the node has no backup store, and with the store's error
    /// where a read fails.
    pub async fn list_backups(&self) -> ClusterResult<Vec<BackupListing>> {
        let store = require_backup_store(self.inner.backups.store())?.clone();
        store.run(list_backups).await
    }
}
