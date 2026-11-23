mod archive;
mod catalog;
mod spool;

use std::path::PathBuf;
use std::sync::Arc;

use narsil::replication::BackupManifest;

use self::catalog::BackupCatalog;
use self::spool::SpoolCache;
use super::feed_source::ClusterFeedSource;
use super::view::DeviceSyncView;
use crate::backups::{BackupRequestDeps, BackupStore, stored_files_of};
use crate::constants::ARCHIVE_ENTRY_ESTIMATE_BYTES;
use crate::error::ClusterResult;
use crate::node::NodeErrorHandler;

pub(crate) use archive::SpooledArchive;

pub(crate) struct DeviceSnapshots {
    store: Option<BackupStore>,
    catalog: Arc<BackupCatalog>,
    spools: SpoolCache,
}

fn estimated_archive_bytes(backup: &BackupManifest) -> u64 {
    stored_files_of(backup)
        .iter()
        .map(|file| file.bytes.saturating_add(ARCHIVE_ENTRY_ESTIMATE_BYTES))
        .fold(0, u64::saturating_add)
}

impl DeviceSnapshots {
    pub(crate) fn new(
        feed: Arc<ClusterFeedSource>,
        store: Option<BackupStore>,
        on_error: Option<NodeErrorHandler>,
    ) -> DeviceSnapshots {
        DeviceSnapshots {
            store,
            catalog: Arc::new(BackupCatalog::new(feed, on_error)),
            spools: SpoolCache::new(),
        }
    }

    pub(crate) fn place_spool(&self, spool_directory: PathBuf) {
        self.spools.place(spool_directory);
    }

    pub(crate) async fn qualifying(
        &self,
        store: &BackupStore,
        index_name: &str,
        partition_count: u32,
        epoch: &str,
    ) -> ClusterResult<Option<BackupManifest>> {
        self.catalog
            .qualifying(store, index_name, partition_count, epoch)
            .await
    }

    pub(crate) async fn start_backup(
        &self,
        requests: &BackupRequestDeps,
        index_name: &str,
        taken_by: &'static str,
    ) -> ClusterResult<()> {
        self.catalog
            .start_backup(requests, index_name, taken_by)
            .await
    }

    pub(crate) async fn acquire(
        &self,
        store: &BackupStore,
        index_name: &str,
        backup: &BackupManifest,
    ) -> ClusterResult<Arc<SpooledArchive>> {
        self.spools.acquire(store, index_name, backup).await
    }

    pub(crate) async fn snapshot_bytes(
        &self,
        view: &DeviceSyncView,
        index_name: &str,
    ) -> ClusterResult<u64> {
        let Some(held) = view.held(index_name) else {
            return Ok(0);
        };
        let (Some(state), Some(store)) = (held.states.sync.as_ref(), self.store.as_ref()) else {
            return Ok(0);
        };
        if let Some(archive) = self.spools.chosen(index_name) {
            return Ok(archive.archive.byte_length());
        }
        let matching = self
            .catalog
            .matching(
                store,
                index_name,
                held.serving.partition_count,
                &state.epoch,
            )
            .await?;
        Ok(matching.first().map_or(0, estimated_archive_bytes))
    }

    pub(crate) async fn close(&self) {
        self.catalog.close().await;
        self.spools.close();
    }
}
