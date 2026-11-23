use std::sync::Arc;

use super::feed::{SyncBounds, SyncCursor, SyncFeedState, SyncRead};
use crate::engine::change_capture::ChangePosition;
use crate::engine::events::FeedChange;
use crate::error::Result;
use crate::filters::Filter;
use crate::value::Map;

/// How fresh the bounds that [`FeedSource::bounds`] returns must be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum BoundsFreshness {
    /// Bounds that a source read a moment ago will do, so a source that reads them over the network can answer
    /// several feeds from one read.
    #[default]
    Recent,
    /// The bounds have to be read after the call begins.
    Current,
}

/// What a [`FeedSource`] tells its listeners about an index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FeedSourceChange {
    /// The log of the index holds new entries.
    Advanced,
    /// A change that each feed of the index has to act on at once.
    Changed(FeedChange),
}

/// A listener that a [`FeedSource`] calls with the name of the index and what changed about it.
pub type FeedSourceListener = Arc<dyn Fn(&str, FeedSourceChange) + Send + Sync>;

/// Tests whether a document matches the filter of a change feed.
pub type DocumentTest = Box<dyn Fn(&Map) -> Result<bool> + Send + Sync>;

/// Stops a listener or a watch of a [`FeedSource`] when the caller drops it.
#[derive(Default)]
pub struct FeedSubscription {
    stop: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl FeedSubscription {
    /// Returns a subscription that calls `stop` once, when the caller drops it.
    pub fn new(stop: impl FnOnce() + Send + Sync + 'static) -> FeedSubscription {
        FeedSubscription {
            stop: Some(Box::new(stop)),
        }
    }
}

impl Drop for FeedSubscription {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

/// The change capture state of an index, which [`ChangeSource::changes_state`] returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangesIndexState {
    /// The index epoch, as 32 lowercase hexadecimal digits.
    pub epoch: String,
    /// The number of partitions of the index.
    pub partition_count: u32,
    /// Whether each log entry of the index holds the document before the write.
    pub previous_document: bool,
}

/// Where a device feed reads a synced index: the engine's own log, or a cluster node that reads each partition
/// from the node that leads it. Each call can block, so an async caller makes it off its executor.
pub trait FeedSource: Send + Sync {
    /// Returns the epoch, the partition count, and the device settings of a synced index, or `None` while device
    /// sync is off for it.
    ///
    /// # Errors
    ///
    /// Fails with `INDEX_NOT_FOUND` where the source holds no index called `index`.
    fn index_state(&self, index: &str) -> Result<Option<SyncFeedState>>;

    /// Returns the oldest, the head, and the highest sequence number of one partition's log.
    ///
    /// # Errors
    ///
    /// Fails where the source cannot read the partition's log.
    fn bounds(&self, index: &str, partition_id: u32, freshness: BoundsFreshness)
    -> Result<SyncBounds>;

    /// Reads the entries of the cursor's partition above the cursor and at or below `up_to`, in sequence order,
    /// while their payloads stay within `max_bytes`, and moves the cursor past them.
    ///
    /// # Errors
    ///
    /// Fails where the source cannot read the partition's log.
    fn read(
        &self,
        index: &str,
        cursor: &mut SyncCursor,
        up_to: u64,
        max_bytes: usize,
    ) -> Result<SyncRead>;

    /// Returns the length in bytes of the history and log of each partition above its position, summed over the
    /// positions.
    ///
    /// # Errors
    ///
    /// Fails where the source cannot read a partition's log.
    fn bytes_behind(&self, index: &str, positions: &[ChangePosition]) -> Result<u64>;

    /// Returns the length of the snapshot that a device loads, or an estimate of it.
    ///
    /// # Errors
    ///
    /// Fails where the source cannot read the snapshot.
    fn snapshot_bytes(&self, index: &str) -> Result<u64>;

    /// Calls `listener` whenever the log of an index advances or a feed of the index has to act on a change,
    /// until the caller drops the returned subscription.
    fn listen(&self, listener: FeedSourceListener) -> FeedSubscription;

    /// Asks the source to report each advance of `index` to its listeners, until the caller drops the returned
    /// subscription, for a source that has to look for advances itself.
    fn watch_index(&self, _index: &str) -> FeedSubscription {
        FeedSubscription::default()
    }
}

/// Where a change feed reads an index: the device feed's log reads, and what a change feed needs beyond them.
pub trait ChangeSource: FeedSource {
    /// Returns the change capture state of an index, or `None` while change capture is off for it.
    ///
    /// # Errors
    ///
    /// Fails with `INDEX_NOT_FOUND` where the source holds no index called `index`.
    fn changes_state(&self, index: &str) -> Result<Option<ChangesIndexState>>;

    /// Returns a test of whether a document matches `filter` under the schema of `index`.
    ///
    /// # Errors
    ///
    /// Fails with `SEARCH_INVALID_FILTER` or `SEARCH_INVALID_FIELD` where the filter does not suit the schema.
    fn document_test(&self, index: &str, filter: &Filter) -> Result<DocumentTest>;

    /// Returns the path of every vector field in the schema of `index`, in code point order.
    ///
    /// # Errors
    ///
    /// Fails where the source cannot read the schema.
    fn vector_fields(&self, index: &str) -> Result<Vec<String>>;

    /// Reports whether the source has set `index` aside, so that a feed with nothing left to read waits without
    /// waking it.
    ///
    /// # Errors
    ///
    /// Fails with `INSTANCE_SHUT_DOWN` once the source has shut down.
    fn index_resting(&self, _index: &str) -> Result<bool> {
        Ok(false)
    }
}
