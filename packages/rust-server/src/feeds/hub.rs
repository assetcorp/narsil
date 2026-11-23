use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use narsil::{ChangeSource, FeedChange, FeedSourceChange, FeedSubscription, Value};
use tokio::sync::Semaphore;

use super::FeedKind;
use super::limits::ByteBudget;
use super::options::ResolvedFeedOptions;
use super::signals::SessionSignals;
use super::wire::{CLOSE_GOING_AWAY, CLOSE_RESYNC, CLOSE_SETTING};
use crate::errors::{ServerError, server_codes};

pub(crate) const SYNC_OFF_REASON: &str = "sync is off";
pub(crate) const CHANGES_OFF_REASON: &str = "change capture is off";
pub(crate) const SERVER_CLOSING_REASON: &str = "server closing";
pub(crate) const PREVIOUS_DOCUMENT_REQUIRED: &str = "CHANGES_PREVIOUS_DOCUMENT_REQUIRED";

#[derive(Default)]
struct HubState {
    closed: bool,
    connections: u64,
    next_session: u64,
    sessions: HashMap<String, HashMap<u64, Arc<SessionSignals>>>,
    subscription: Option<FeedSubscription>,
    watches: HashMap<String, FeedSubscription>,
    listening: bool,
}

pub(crate) struct Hub {
    pub(crate) kind: FeedKind,
    pub(crate) options: ResolvedFeedOptions,
    pub(crate) reads: Arc<Semaphore>,
    pub(crate) budget: Arc<ByteBudget>,
    pub(crate) allow_regex: bool,
    state: Mutex<HubState>,
}

pub(crate) struct ConnectionSlot {
    hub: Arc<Hub>,
}

pub(crate) struct Membership {
    hub: Arc<Hub>,
    index: String,
    id: u64,
}

fn closing() -> ServerError {
    ServerError::new(
        429,
        server_codes::TOO_MANY_REQUESTS,
        "The server is closing its feed connections",
    )
}

impl Hub {
    pub(crate) fn new(kind: FeedKind, options: ResolvedFeedOptions, allow_regex: bool) -> Hub {
        let permits = usize::try_from(options.max_catch_ups)
            .unwrap_or(usize::MAX)
            .min(Semaphore::MAX_PERMITS);
        Hub {
            kind,
            reads: Arc::new(Semaphore::new(permits)),
            budget: Arc::new(ByteBudget::new(options.max_buffered_bytes)),
            options,
            allow_regex,
            state: Mutex::new(HubState::default()),
        }
    }

    fn state(&self) -> MutexGuard<'_, HubState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn refuse_when_closed(&self) -> Result<(), ServerError> {
        if self.state().closed {
            return Err(closing());
        }
        Ok(())
    }

    pub(crate) fn reserve(self: &Arc<Self>) -> Result<ConnectionSlot, ServerError> {
        let mut state = self.state();
        if state.closed {
            return Err(closing());
        }
        if state.connections >= self.options.max_connections {
            let noun = match self.kind {
                FeedKind::Sync => "feed connections",
                FeedKind::Changes => "change feed connections",
            };
            return Err(ServerError::new(
                429,
                server_codes::TOO_MANY_REQUESTS,
                format!(
                    "The server holds {} {noun}, the most that it accepts",
                    state.connections
                ),
            )
            .with_detail(
                "maximum",
                Value::Number(self.options.max_connections as f64),
            ));
        }
        state.connections += 1;
        Ok(ConnectionSlot {
            hub: Arc::clone(self),
        })
    }

    pub(crate) fn join(
        self: &Arc<Self>,
        source: &Arc<dyn ChangeSource>,
        index: &str,
        signals: &Arc<SessionSignals>,
    ) -> Option<Membership> {
        let register = {
            let mut state = self.state();
            if state.closed {
                return None;
            }
            state.next_session = state.next_session.wrapping_add(1);
            let id = state.next_session;
            if !state.sessions.contains_key(index) {
                let watch = source.watch_index(index);
                state.watches.insert(index.to_string(), watch);
            }
            state
                .sessions
                .entry(index.to_string())
                .or_default()
                .insert(id, Arc::clone(signals));
            let register = !state.listening;
            state.listening = true;
            (register, id)
        };
        if register.0 {
            self.listen(source);
        }
        Some(Membership {
            hub: Arc::clone(self),
            index: index.to_string(),
            id: register.1,
        })
    }

    fn listen(self: &Arc<Self>, source: &Arc<dyn ChangeSource>) {
        let hub: Weak<Hub> = Arc::downgrade(self);
        let subscription = source.listen(Arc::new(move |index, change| {
            if let Some(hub) = hub.upgrade() {
                hub.on_change(index, change);
            }
        }));
        let mut state = self.state();
        if state.closed {
            drop(state);
            drop(subscription);
            return;
        }
        state.subscription = Some(subscription);
    }

    fn sessions_of(&self, index: &str) -> Vec<Arc<SessionSignals>> {
        self.state()
            .sessions
            .get(index)
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default()
    }

    fn on_change(&self, index: &str, change: FeedSourceChange) {
        let change = match change {
            FeedSourceChange::Advanced => None,
            FeedSourceChange::Changed(change) => Some(change),
        };
        let sessions = self.sessions_of(index);
        for session in sessions {
            match (self.kind, change) {
                (_, None) => session.advance(),
                (_, Some(FeedChange::Epoch)) => session.resync_epoch(),
                (FeedKind::Sync, Some(FeedChange::Settings)) => session.settings(),
                (FeedKind::Sync, Some(FeedChange::SyncOff | FeedChange::Dropped)) => {
                    session.close(CLOSE_RESYNC, SYNC_OFF_REASON)
                }
                (FeedKind::Changes, Some(FeedChange::ChangesOff | FeedChange::Dropped)) => {
                    session.close(CLOSE_RESYNC, CHANGES_OFF_REASON)
                }
                (FeedKind::Changes, Some(FeedChange::PreviousDocumentOff)) => {
                    session.close_if_filtered(CLOSE_SETTING, PREVIOUS_DOCUMENT_REQUIRED)
                }
                _ => {}
            }
        }
    }

    pub(crate) fn close(&self) {
        let (sessions, subscription, watches) = {
            let mut state = self.state();
            state.closed = true;
            let sessions: Vec<Arc<SessionSignals>> = state
                .sessions
                .values()
                .flat_map(|sessions| sessions.values().cloned())
                .collect();
            (
                sessions,
                state.subscription.take(),
                std::mem::take(&mut state.watches),
            )
        };
        for session in sessions {
            session.close(CLOSE_GOING_AWAY, SERVER_CLOSING_REASON);
        }
        drop(watches);
        drop(subscription);
    }
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        let mut state = self.hub.state();
        state.connections = state.connections.saturating_sub(1);
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        let watch = {
            let mut state = self.hub.state();
            let emptied = state.sessions.get_mut(&self.index).is_some_and(|sessions| {
                sessions.remove(&self.id);
                sessions.is_empty()
            });
            if emptied {
                state.sessions.remove(&self.index);
                state.watches.remove(&self.index)
            } else {
                None
            }
        };
        drop(watch);
    }
}
