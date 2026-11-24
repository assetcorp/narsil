use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::engine::Narsil;
use crate::engine::sync::source::{ChangeSource, FeedSubscription};
use crate::error::Result;

use super::constants::{CHANGE_FOLLOW_INTERVAL_MS, CHANGE_READ_CHUNK_BYTES};
use super::open::{Opened, open_from_source};
use super::step::{Following, Step, step};
use super::types::{ChangePosition, ChangesEvent, ChangesRequest};

#[derive(Default)]
struct SignalState {
    stopped: bool,
    woken: bool,
}

#[derive(Default)]
struct FeedSignal {
    state: Mutex<SignalState>,
    wake: Condvar,
}

impl FeedSignal {
    fn state(&self) -> MutexGuard<'_, SignalState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wake(&self) {
        self.state().woken = true;
        self.wake.notify_all();
    }

    fn stop(&self) {
        self.state().stopped = true;
        self.wake.notify_all();
    }

    fn stopped(&self) -> bool {
        self.state().stopped
    }

    fn take_wake(&self) {
        self.state().woken = false;
    }

    fn wait(&self, timeout: Duration) {
        let state = self.state();
        let _ = self
            .wake
            .wait_timeout_while(state, timeout, |state| !state.woken && !state.stopped);
    }
}

/// Stops a [`ChangeFeed`] from another thread: the feed's next call returns `None`, and a call that waits returns
/// at once.
#[derive(Clone)]
pub struct ChangeFeedStop {
    signal: Arc<FeedSignal>,
}

impl ChangeFeedStop {
    /// Stops the feed.
    pub fn stop(&self) {
        self.signal.stop();
    }
}

/// The changes of one index, which [`Narsil::changes`] returns: the subscribed event first, then each group of
/// changes as the log makes it durable, until the caller stops the feed or the feed returns a resync or an error.
///
/// As an iterator, the feed waits for the next event, so call [`ChangeFeed::next_within`] to wait no longer than a
/// limit, and [`ChangeFeed::stopper`] to stop the feed from another thread. The feed reads the log from its files in
/// ranges of at most 1 MiB of documents, so it holds one range in memory at a time.
pub struct ChangeFeed {
    source: Arc<dyn ChangeSource>,
    index_name: String,
    signal: Arc<FeedSignal>,
    subscriptions: Vec<FeedSubscription>,
    pending: VecDeque<Result<ChangesEvent>>,
    following: Option<Box<Following>>,
}

impl ChangeFeed {
    /// Returns the changes of an index of `source` above the request's positions, as [`Narsil::changes`] does for
    /// the log of the local engine, so that a cluster node follows an index whose partitions other nodes lead.
    ///
    /// # Errors
    ///
    /// Fails as [`Narsil::changes`] does.
    pub fn follow(
        source: Arc<dyn ChangeSource>,
        index: &str,
        request: &ChangesRequest,
    ) -> Result<ChangeFeed> {
        let opened = open_from_source(source.as_ref(), index, request)?;
        ChangeFeed::start(source, index, opened)
    }

    fn start(source: Arc<dyn ChangeSource>, index: &str, opened: Opened) -> Result<ChangeFeed> {
        let signal = Arc::new(FeedSignal::default());
        let mut feed = ChangeFeed {
            source,
            index_name: index.to_string(),
            signal: Arc::clone(&signal),
            subscriptions: Vec::new(),
            pending: VecDeque::new(),
            following: None,
        };
        match opened {
            Opened::Resync(reason) => feed.pending.push_back(Ok(ChangesEvent::Resync(reason))),
            Opened::Following(following, mut subscribed) => {
                subscribed.bytes_behind = feed.source.bytes_behind(index, &subscribed.positions)?;
                let name = index.to_string();
                let woken = Arc::clone(&signal);
                feed.subscriptions
                    .push(feed.source.listen(Arc::new(move |changed, _| {
                        if changed == name {
                            woken.wake();
                        }
                    })));
                feed.subscriptions.push(feed.source.watch_index(index));
                feed.pending
                    .push_back(Ok(ChangesEvent::Subscribed(subscribed)));
                feed.following = Some(following);
            }
        }
        Ok(feed)
    }

    /// Returns a handle that stops this feed from any thread.
    pub fn stopper(&self) -> ChangeFeedStop {
        ChangeFeedStop {
            signal: Arc::clone(&self.signal),
        }
    }

    /// Stops the feed, after which every call returns `None`.
    pub fn stop(&mut self) {
        self.signal.stop();
        self.finish();
    }

    /// Reports whether the feed has ended, after a stop, a resync, or an error, so that it returns no further event.
    pub fn is_finished(&self) -> bool {
        self.following.is_none() && self.pending.is_empty()
    }

    /// Returns the next event, waiting at most `timeout` for one, or `None` where none arrives in that time or the
    /// feed has ended, which [`ChangeFeed::is_finished`] tells apart.
    pub fn next_within(&mut self, timeout: Duration) -> Option<Result<ChangesEvent>> {
        self.next_event(Some(Instant::now() + timeout), CHANGE_READ_CHUNK_BYTES)
    }

    /// Returns the next event as [`ChangeFeed::next_within`] does, reading at most `max_bytes` of documents for it,
    /// and never more than 1 MiB, so that a server can keep each group within the room that its window leaves. A
    /// read always takes its first entry, so a group of one entry can pass `max_bytes`.
    pub fn next_within_bytes(
        &mut self,
        timeout: Duration,
        max_bytes: usize,
    ) -> Option<Result<ChangesEvent>> {
        let budget = max_bytes.clamp(1, CHANGE_READ_CHUNK_BYTES);
        self.next_event(Some(Instant::now() + timeout), budget)
    }

    /// Moves the feed back to `position` in its partition, so that its next read of the partition returns the
    /// changes above that position again, as a server does with a group that its window had no room to send. A
    /// position at or above the current position of the feed leaves the feed as it stands.
    pub fn rewind(&mut self, position: ChangePosition) {
        if let Some(following) = self.following.as_mut() {
            following.rewind(position.partition_id as usize, position.seq_no);
        }
    }

    fn finish(&mut self) {
        self.following = None;
        self.subscriptions.clear();
    }

    fn end_with(&mut self, event: Result<ChangesEvent>) -> Option<Result<ChangesEvent>> {
        self.finish();
        Some(event)
    }

    fn next_event(
        &mut self,
        deadline: Option<Instant>,
        budget_bytes: usize,
    ) -> Option<Result<ChangesEvent>> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Some(event);
            }
            if self.signal.stopped() {
                self.finish();
                return None;
            }
            let following = self.following.as_mut()?;
            self.signal.take_wake();
            match step(
                self.source.as_ref(),
                &self.index_name,
                following,
                budget_bytes,
            ) {
                Err(error) => return self.end_with(Err(error)),
                Ok(Step::Resync(reason)) => return self.end_with(Ok(ChangesEvent::Resync(reason))),
                Ok(Step::Group(group)) => return Some(Ok(ChangesEvent::Changes(group))),
                Ok(Step::Idle) => {}
            }
            let interval = Duration::from_millis(CHANGE_FOLLOW_INTERVAL_MS);
            let wait = match deadline {
                None => interval,
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return None;
                    }
                    left.min(interval)
                }
            };
            self.signal.wait(wait);
        }
    }
}

impl Iterator for ChangeFeed {
    type Item = Result<ChangesEvent>;

    fn next(&mut self) -> Option<Result<ChangesEvent>> {
        self.next_event(None, CHANGE_READ_CHUNK_BYTES)
    }
}

impl Drop for ChangeFeed {
    fn drop(&mut self) {
        self.finish();
    }
}

impl Narsil {
    /// Returns the changes of an index above a list of positions, and then each later change as the log makes it
    /// durable, until the caller stops the feed.
    ///
    /// The feed's first event is [`ChangesEvent::Subscribed`], which gives the epoch and the positions. Each later
    /// event holds the changes of one partition in sequence order, with the `scanned_seq_no` that the caller saves
    /// as the partition's position once it has applied them. Where the positions no longer lead to the index's
    /// changes, the feed returns [`ChangesEvent::Resync`] and ends, and the caller takes a document export and
    /// follows again from the positions in its header. A request without an epoch and positions starts at the
    /// heads. The feed ends with `CHANGES_NOT_ENABLED` once capture turns off, and a filtered feed ends with
    /// `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` once the index stops recording previous documents.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, with `CHANGES_NOT_ENABLED` where
    /// change capture is off, with `CHANGES_INVALID_POSITIONS` where the epoch is not 32 lowercase hexadecimal
    /// digits, where the request gives only one of the epoch and the positions, or where the positions leave out a
    /// partition, repeat one, or give one that the index lacks, with `CHANGES_PREVIOUS_DOCUMENT_REQUIRED` where the
    /// request holds a filter and the index records no previous document, with `SEARCH_INVALID_FILTER` where the
    /// filter breaks the shape or the limits of a query's filters, and with `SEARCH_INVALID_FIELD` where the filter
    /// tests a field which the schema leaves out.
    pub fn changes(&self, index: &str, request: &ChangesRequest) -> Result<ChangeFeed> {
        let source: Arc<dyn ChangeSource> = self.feed_source();
        let opened = {
            let (_name, state) = self.inner.open_index_in_turn(index)?;
            let _writer = state.lock_writes()?;
            open_from_source(source.as_ref(), index, request)?
        };
        ChangeFeed::start(source, index, opened)
    }
}
