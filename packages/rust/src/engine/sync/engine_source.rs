use std::sync::{Arc, Weak};

use super::feed::{SyncBounds, SyncCursor, SyncFeedState, SyncRead};
use super::source::{
    BoundsFreshness, ChangeSource, ChangesIndexState, DocumentTest, FeedSource, FeedSourceChange,
    FeedSourceListener, FeedSubscription,
};
use crate::engine::change_capture::{ChangeFilter, ChangePosition};
use crate::engine::events::{NarsilEvent, NarsilEventKind};
use crate::engine::index::IndexState;
use crate::engine::{EngineInner, Narsil};
use crate::error::{Result, index_not_found, instance_shut_down};
use crate::filters::Filter;
use crate::value::Map;

/// The feed source of one engine, which [`Narsil::feed_source`] returns: it reads the engine's own log, and it
/// holds the engine weakly, so a feed that outlives the engine fails with `INSTANCE_SHUT_DOWN`.
pub struct EngineFeedSource {
    engine: Weak<EngineInner>,
}

impl EngineFeedSource {
    fn inner(&self) -> Result<Arc<EngineInner>> {
        self.engine.upgrade().ok_or_else(instance_shut_down)
    }

    fn narsil(&self) -> Result<Narsil> {
        self.inner().map(|inner| Narsil { inner })
    }
}

fn reach_index(engine: &EngineInner, index: &str) -> Result<Arc<IndexState>> {
    engine.guard_shutdown()?;
    if let Some(state) = engine.open_index_named(index) {
        return Ok(state);
    }
    if !engine.holds_index(index) {
        return Err(index_not_found(index));
    }
    engine.open_index(index)
}

impl FeedSource for EngineFeedSource {
    fn index_state(&self, index: &str) -> Result<Option<SyncFeedState>> {
        self.narsil()?.sync_feed_state(index)
    }

    fn bounds(&self, index: &str, partition_id: u32, _: BoundsFreshness) -> Result<SyncBounds> {
        self.narsil()?.sync_bounds(index, partition_id)
    }

    fn read(
        &self,
        index: &str,
        cursor: &mut SyncCursor,
        up_to: u64,
        max_bytes: usize,
    ) -> Result<SyncRead> {
        self.narsil()?
            .read_sync_entries(index, cursor, up_to, max_bytes)
    }

    fn bytes_behind(&self, index: &str, positions: &[ChangePosition]) -> Result<u64> {
        self.narsil()?.sync_bytes_behind(index, positions)
    }

    fn snapshot_bytes(&self, index: &str) -> Result<u64> {
        self.narsil()?.sync_snapshot_bytes(index)
    }

    fn listen(&self, listener: FeedSourceListener) -> FeedSubscription {
        let Some(engine) = self.engine.upgrade() else {
            return FeedSubscription::default();
        };
        let ids: Vec<_> = [NarsilEventKind::Write, NarsilEventKind::FeedChange]
            .into_iter()
            .map(|kind| {
                let listener = Arc::clone(&listener);
                engine.events.add_listener(
                    kind,
                    Arc::new(move |event: &NarsilEvent| match event {
                        NarsilEvent::Write { index_name } => {
                            listener(index_name, FeedSourceChange::Advanced)
                        }
                        NarsilEvent::FeedChange { index_name, change } => {
                            listener(index_name, FeedSourceChange::Changed(*change))
                        }
                        _ => {}
                    }),
                )
            })
            .collect();
        let held = Arc::downgrade(&engine);
        FeedSubscription::new(move || {
            if let Some(engine) = held.upgrade() {
                for id in ids {
                    engine.events.remove_listener(id);
                }
            }
        })
    }
}

impl ChangeSource for EngineFeedSource {
    fn changes_state(&self, index: &str) -> Result<Option<ChangesIndexState>> {
        let state = reach_index(&*self.inner()?, index)?;
        let Some(log) = state.log().filter(|log| log.log_store().is_some()) else {
            return Ok(None);
        };
        let (Some(epoch), previous_document) = log.recorded_capture() else {
            return Ok(None);
        };
        Ok(Some(ChangesIndexState {
            epoch,
            partition_count: state.partitions().len() as u32,
            previous_document,
        }))
    }

    fn document_test(&self, index: &str, filter: &Filter) -> Result<DocumentTest> {
        let state = reach_index(&*self.inner()?, index)?;
        let filter = ChangeFilter::new(filter, &state)?;
        let (engine, name) = (Weak::clone(&self.engine), index.to_string());
        Ok(Box::new(move |document: &Map| {
            let engine = engine.upgrade().ok_or_else(instance_shut_down)?;
            let state = reach_index(&engine, &name)?;
            filter.matches(&state, &engine.search_limits, document)
        }))
    }

    fn vector_fields(&self, index: &str) -> Result<Vec<String>> {
        self.narsil()?.vector_fields(index)
    }

    fn index_resting(&self, index: &str) -> Result<bool> {
        let engine = self.inner()?;
        engine.guard_shutdown()?;
        Ok(engine.open_index_named(index).is_none() && engine.holds_index(index))
    }
}

impl Narsil {
    /// Returns the engine's feed source, which reads the engine's own log for a device feed and a change feed, so
    /// that a server serves an engine and a cluster node through one [`ChangeSource`].
    pub fn feed_source(&self) -> Arc<EngineFeedSource> {
        Arc::new(EngineFeedSource {
            engine: Arc::downgrade(&self.inner),
        })
    }
}
