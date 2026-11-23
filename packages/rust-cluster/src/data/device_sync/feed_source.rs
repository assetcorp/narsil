use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use narsil::{
    BoundsFreshness, ChangePosition, FeedSource, FeedSourceChange, FeedSourceListener,
    FeedSubscription, ListenerId, NarsilEvent, NarsilEventKind, SyncBounds, SyncCursor,
    SyncFeedState, SyncRead,
};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use super::bridge::wait_on;
use super::held::HeldSyncIndex;
use super::primary_read::PrimaryReads;
use crate::constants::{DEVICE_SYNC_BOUNDS_REUSE_MS, DEVICE_SYNC_HEAD_POLL_MS, MAX_SAFE_INTEGER};
use crate::controller::lock;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::copies::LocalCopies;
use crate::error::ClusterResult;

const NO_ENTRIES_AFTER: u64 = MAX_SAFE_INTEGER;
const BOUNDS_READ_BYTES: u32 = 1;
const MAX_READ_BYTES: usize = u32::MAX as usize;

pub(in crate::data) struct FeedParts {
    pub(in crate::data) runtime: Handle,
    pub(in crate::data) reads: Arc<PrimaryReads>,
    pub(in crate::data) copies: Arc<LocalCopies>,
    pub(in crate::data) coordinator: Arc<EtcdCoordinator>,
}

#[derive(Default)]
struct FeedState {
    reused_bounds: HashMap<(String, u32), (Instant, SyncBounds)>,
    watched: HashMap<String, usize>,
    last_heads: HashMap<(String, u32), u64>,
    listeners: HashMap<u64, FeedSourceListener>,
    next_listener: u64,
    poll: Option<JoinHandle<()>>,
    local_writes: Option<ListenerId>,
}

#[derive(Default)]
pub(crate) struct ClusterFeedSource {
    pub(super) parts: Mutex<Option<Arc<FeedParts>>>,
    state: Mutex<FeedState>,
}

fn bounds_of(reply: &crate::data::writes::SyncReadReply) -> SyncBounds {
    SyncBounds {
        oldest_seq_no: reply.oldest_seq_no,
        head: reply.head,
        highest_seq_no: reply.highest_seq_no,
    }
}

impl ClusterFeedSource {
    pub(in crate::data) fn attach(&self, parts: FeedParts) {
        *lock(&self.parts) = Some(Arc::new(parts));
    }

    pub(crate) fn detach(&self) {
        let parts = lock(&self.parts).take();
        let mut state = lock(&self.state);
        if let Some(poll) = state.poll.take() {
            poll.abort();
        }
        if let (Some(parts), Some(id)) = (parts, state.local_writes.take()) {
            parts.copies.engine.off(id);
        }
        state.reused_bounds.clear();
        state.last_heads.clear();
    }

    pub(in crate::data) fn parts(&self) -> narsil::Result<Arc<FeedParts>> {
        lock(&self.parts).clone().ok_or_else(|| {
            narsil::NarsilError::new(
                narsil::ErrorCode::INSTANCE_SHUT_DOWN,
                "The cluster node serves no feed until its data role starts",
            )
        })
    }

    fn emit(&self, index_name: &str, change: FeedSourceChange) {
        let listeners: Vec<FeedSourceListener> =
            lock(&self.state).listeners.values().cloned().collect();
        for listener in listeners {
            listener(index_name, change);
        }
    }

    fn reused(&self, key: &(String, u32)) -> Option<SyncBounds> {
        let state = lock(&self.state);
        let (at, bounds) = state.reused_bounds.get(key)?;
        (at.elapsed() < Duration::from_millis(DEVICE_SYNC_BOUNDS_REUSE_MS)).then_some(*bounds)
    }

    async fn read_bounds(
        self: Arc<Self>,
        reads: Arc<PrimaryReads>,
        index_name: String,
        partition_id: u32,
        freshness: BoundsFreshness,
    ) -> ClusterResult<SyncBounds> {
        let key = (index_name, partition_id);
        if freshness == BoundsFreshness::Recent
            && let Some(bounds) = self.reused(&key)
        {
            return Ok(bounds);
        }
        let reply = reads
            .read_from_primary(&key.0, partition_id, NO_ENTRIES_AFTER, BOUNDS_READ_BYTES)
            .await?;
        let bounds = bounds_of(&reply);
        lock(&self.state)
            .reused_bounds
            .insert(key, (Instant::now(), bounds));
        Ok(bounds)
    }

    async fn poll_heads(self: Arc<Self>) {
        let Ok(parts) = self.parts() else {
            return;
        };
        let watched: Vec<String> = lock(&self.state).watched.keys().cloned().collect();
        for index_name in watched {
            let Some(held) = parts.reads.view.held(&index_name) else {
                continue;
            };
            let mut rose = false;
            for partition_id in 0..held.serving.partition_count {
                let read = Arc::clone(&self)
                    .read_bounds(
                        Arc::clone(&parts.reads),
                        index_name.clone(),
                        partition_id,
                        BoundsFreshness::Recent,
                    )
                    .await;
                let Ok(bounds) = read else {
                    continue;
                };
                let key = (index_name.clone(), partition_id);
                let mut state = lock(&self.state);
                if state
                    .last_heads
                    .get(&key)
                    .is_none_or(|last| bounds.head > *last)
                {
                    rose = true;
                }
                state.last_heads.insert(key, bounds.head);
            }
            if rose {
                self.emit(&index_name, FeedSourceChange::Advanced);
            }
        }
    }

    fn start_polling(self: &Arc<Self>, runtime: &Handle) {
        let source: Weak<ClusterFeedSource> = Arc::downgrade(self);
        let task = runtime.spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_millis(DEVICE_SYNC_HEAD_POLL_MS));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                let Some(source) = source.upgrade() else {
                    return;
                };
                source.poll_heads().await;
            }
        });
        lock(&self.state).poll = Some(task);
    }

    fn on_local_write(&self, local_name: &str) {
        let Ok(parts) = self.parts() else {
            return;
        };
        let served = parts.reads.view.names_served_by_local(local_name);
        let mut advanced = Vec::new();
        {
            let mut state = lock(&self.state);
            for index_name in served {
                if !state.watched.contains_key(&index_name) {
                    continue;
                }
                state
                    .reused_bounds
                    .retain(|(name, _), _| *name != index_name);
                advanced.push(index_name);
            }
        }
        for index_name in advanced {
            self.emit(&index_name, FeedSourceChange::Advanced);
        }
    }

    pub(super) fn held_now(&self, index_name: &str) -> narsil::Result<Option<HeldSyncIndex>> {
        let parts = self.parts()?;
        match parts.reads.view.held(index_name) {
            Some(held) => Ok(Some(held)),
            None => {
                let (view, name) = (Arc::clone(&parts.reads.view), index_name.to_string());
                wait_on(&parts.runtime, async move { view.current(&name).await })
            }
        }
    }

    pub(crate) fn source_state(&self, index_name: &str) -> narsil::Result<Option<SyncFeedState>> {
        let held = self.held_now(index_name)?;
        Ok(held.and_then(|held| {
            let sync = held.states.sync?;
            Some(SyncFeedState {
                epoch: sync.epoch,
                partition_count: held.serving.partition_count,
                settings: held.feed_settings,
            })
        }))
    }

    pub(crate) fn listen_shared(
        self: &Arc<Self>,
        listener: FeedSourceListener,
    ) -> FeedSubscription {
        let Ok(parts) = self.parts() else {
            return FeedSubscription::default();
        };
        let id = {
            let mut state = lock(&self.state);
            state.next_listener = state.next_listener.wrapping_add(1);
            let id = state.next_listener;
            state.listeners.insert(id, Arc::clone(&listener));
            if state.local_writes.is_none() {
                let source = Arc::downgrade(self);
                state.local_writes = Some(parts.copies.engine.on(
                    NarsilEventKind::Write,
                    move |event| {
                        if let (Some(source), NarsilEvent::Write { index_name }) =
                            (source.upgrade(), event)
                        {
                            source.on_local_write(index_name);
                        }
                    },
                ));
            }
            id
        };
        let view_subscription = parts.reads.view.listen(listener);
        let source = Arc::downgrade(self);
        FeedSubscription::new(move || {
            drop(view_subscription);
            let Some(source) = source.upgrade() else {
                return;
            };
            let mut state = lock(&source.state);
            state.listeners.remove(&id);
            if state.listeners.is_empty()
                && let Some(local) = state.local_writes.take()
            {
                drop(state);
                if let Ok(parts) = source.parts() {
                    parts.copies.engine.off(local);
                }
            }
        })
    }

    pub(crate) fn watch_shared(self: &Arc<Self>, index_name: &str) -> FeedSubscription {
        let Ok(parts) = self.parts() else {
            return FeedSubscription::default();
        };
        let start = {
            let mut state = lock(&self.state);
            *state.watched.entry(index_name.to_string()).or_insert(0) += 1;
            state.poll.is_none()
        };
        if start {
            self.start_polling(&parts.runtime);
        }
        let (source, name) = (Arc::downgrade(self), index_name.to_string());
        FeedSubscription::new(move || {
            let Some(source) = source.upgrade() else {
                return;
            };
            let mut state = lock(&source.state);
            let remaining = state
                .watched
                .get(&name)
                .map_or(0, |count| count.saturating_sub(1));
            if remaining > 0 {
                state.watched.insert(name, remaining);
                return;
            }
            state.watched.remove(&name);
            state.last_heads.retain(|(watched, _), _| *watched != name);
            if state.watched.is_empty()
                && let Some(poll) = state.poll.take()
            {
                poll.abort();
            }
        })
    }

    pub(crate) fn bounds_now(
        self: &Arc<Self>,
        index_name: &str,
        partition_id: u32,
        freshness: BoundsFreshness,
    ) -> narsil::Result<SyncBounds> {
        let parts = self.parts()?;
        let read = Arc::clone(self).read_bounds(
            Arc::clone(&parts.reads),
            index_name.to_string(),
            partition_id,
            freshness,
        );
        wait_on(&parts.runtime, read)
    }

    pub(crate) fn read_now(
        &self,
        index_name: &str,
        cursor: &mut SyncCursor,
        up_to: u64,
        max_bytes: usize,
    ) -> narsil::Result<SyncRead> {
        let parts = self.parts()?;
        let (partition_id, after_seq_no) = (cursor.partition_id(), cursor.position());
        let max_bytes = max_bytes.clamp(1, MAX_READ_BYTES) as u32;
        let (reads, name) = (Arc::clone(&parts.reads), index_name.to_string());
        let reply = wait_on(&parts.runtime, async move {
            reads
                .read_from_primary(&name, partition_id, after_seq_no, max_bytes)
                .await
        })?;
        let gone =
            after_seq_no.saturating_add(1) < reply.oldest_seq_no && after_seq_no < reply.head;
        if gone {
            return Ok(SyncRead::HistoryGone);
        }
        let entries: Vec<_> = reply
            .entries
            .into_iter()
            .filter(|entry| entry.seq_no <= up_to)
            .collect();
        if let Some(last) = entries.last() {
            *cursor = SyncCursor::after(partition_id, last.seq_no);
        }
        Ok(SyncRead::Entries(entries))
    }

    pub(crate) fn bytes_behind_now(
        &self,
        index_name: &str,
        positions: &[ChangePosition],
    ) -> narsil::Result<u64> {
        let parts = self.parts()?;
        let (reads, name, positions) = (
            Arc::clone(&parts.reads),
            index_name.to_string(),
            positions.to_vec(),
        );
        wait_on(&parts.runtime, async move {
            let mut bytes = 0u64;
            for position in positions {
                let reply = reads
                    .read_from_primary(
                        &name,
                        position.partition_id,
                        position.seq_no,
                        BOUNDS_READ_BYTES,
                    )
                    .await?;
                bytes = bytes.saturating_add(reply.bytes_behind);
            }
            Ok(bytes)
        })
    }
}

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
}
