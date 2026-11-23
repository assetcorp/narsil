use std::sync::Arc;

use narsil::{
    BoundsFreshness, ChangePosition, FeedSource, FeedSourceListener, FeedSubscription, SyncBounds,
    SyncCursor, SyncFeedState, SyncRead,
};

use super::admission::DEVICE_SYNC_READINESS;
use super::bridge::wait_on;
use super::feed_source::ClusterFeedSource;
use super::snapshots::DeviceSnapshots;

pub(crate) struct SharedFeedSource(
    pub(crate) Arc<ClusterFeedSource>,
    pub(crate) Option<Arc<DeviceSnapshots>>,
);

impl FeedSource for SharedFeedSource {
    fn index_state(&self, index: &str) -> narsil::Result<Option<SyncFeedState>> {
        self.0.source_state(index)
    }

    fn bounds(
        &self,
        index: &str,
        partition_id: u32,
        freshness: BoundsFreshness,
    ) -> narsil::Result<SyncBounds> {
        self.0.bounds_now(index, partition_id, freshness)
    }

    fn read(
        &self,
        index: &str,
        cursor: &mut SyncCursor,
        up_to: u64,
        max_bytes: usize,
    ) -> narsil::Result<SyncRead> {
        self.0.read_now(index, cursor, up_to, max_bytes)
    }

    fn bytes_behind(&self, index: &str, positions: &[ChangePosition]) -> narsil::Result<u64> {
        self.0.bytes_behind_now(index, positions)
    }

    fn snapshot_bytes(&self, index: &str) -> narsil::Result<u64> {
        let Some(snapshots) = &self.1 else {
            return Ok(0);
        };
        let parts = self.0.parts()?;
        let (snapshots, view) = (Arc::clone(snapshots), Arc::clone(&parts.reads.view));
        let name = index.to_string();
        wait_on(&parts.runtime, async move {
            snapshots.snapshot_bytes(&view, &name).await
        })
    }

    fn listen(&self, listener: FeedSourceListener) -> FeedSubscription {
        self.0.listen_shared(listener)
    }

    fn watch_index(&self, index: &str) -> FeedSubscription {
        self.0.watch_shared(index)
    }

    fn admit_feed(&self, index: &str) -> narsil::Result<()> {
        self.admit(index, &DEVICE_SYNC_READINESS)
    }
}
