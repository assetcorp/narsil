use std::sync::Arc;

use narsil::{
    BoundsFreshness, ChangePosition, FeedSource, FeedSourceListener, FeedSubscription, SyncBounds,
    SyncCursor, SyncFeedState, SyncRead,
};

use super::admission::DEVICE_SYNC_READINESS;
use super::feed_source::ClusterFeedSource;

pub(crate) struct SharedFeedSource(pub(crate) Arc<ClusterFeedSource>);

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

    fn snapshot_bytes(&self, _index: &str) -> narsil::Result<u64> {
        Ok(0)
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
