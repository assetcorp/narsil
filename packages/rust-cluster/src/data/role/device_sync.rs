use std::sync::Arc;

use super::DataRole;
use crate::data::device_sync::{DeviceSnapshots, DeviceSyncView, SharedFeedSource};
use crate::error::ClusterResult;
use crate::node::not_ready;

impl DataRole {
    pub(crate) fn feed_source(&self) -> Arc<SharedFeedSource> {
        Arc::new(SharedFeedSource(
            Arc::clone(&self.feed),
            Some(Arc::clone(&self.snapshots)),
        ))
    }

    pub(crate) fn device_snapshots(&self) -> &DeviceSnapshots {
        &self.snapshots
    }

    pub(crate) async fn device_sync_view(&self) -> ClusterResult<Arc<DeviceSyncView>> {
        self.device_sync
            .lock()
            .await
            .clone()
            .ok_or_else(|| not_ready(&self.node_id))
    }

    pub(crate) fn keeps_write_ahead_log(&self) -> bool {
        self.config
            .engine
            .durability
            .as_ref()
            .is_some_and(|durability| {
                durability.directory.is_some()
                    && durability.tier != Some(narsil::DurabilityTier::Snapshot)
            })
    }

    pub(crate) async fn refresh_device_sync(&self, index_name: &str) -> ClusterResult<()> {
        let view = self.device_sync.lock().await.clone();
        match view {
            Some(view) => view.refresh(index_name).await,
            None => Ok(()),
        }
    }
}
