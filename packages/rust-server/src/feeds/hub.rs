use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use narsil::{FeedChange, ListenerId, Narsil, NarsilEvent, NarsilEventKind, Value};
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
    listeners: Vec<ListenerId>,
    listening: bool,
    engine: Option<Arc<Narsil>>,
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
        engine: &Arc<Narsil>,
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
            self.listen(engine);
        }
        Some(Membership {
            hub: Arc::clone(self),
            index: index.to_string(),
            id: register.1,
        })
    }

    fn listen(self: &Arc<Self>, engine: &Arc<Narsil>) {
        let ids: Vec<ListenerId> = [NarsilEventKind::Write, NarsilEventKind::FeedChange]
            .into_iter()
            .map(|kind| {
                let hub: Weak<Hub> = Arc::downgrade(self);
                engine.on(kind, move |event| {
                    if let Some(hub) = hub.upgrade() {
                        hub.on_event(event);
                    }
                })
            })
            .collect();
        let mut state = self.state();
        if state.closed {
            drop(state);
            for id in ids {
                engine.off(id);
            }
            return;
        }
        state.listeners = ids;
        state.engine = Some(Arc::clone(engine));
    }

    fn sessions_of(&self, index: &str) -> Vec<Arc<SessionSignals>> {
        self.state()
            .sessions
            .get(index)
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default()
    }

    fn on_event(&self, event: &NarsilEvent) {
        let (index, change) = match event {
            NarsilEvent::Write { index_name } => (index_name, None),
            NarsilEvent::FeedChange { index_name, change } => (index_name, Some(*change)),
            _ => return,
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
        let (sessions, listeners, engine) = {
            let mut state = self.state();
            state.closed = true;
            let sessions: Vec<Arc<SessionSignals>> = state
                .sessions
                .values()
                .flat_map(|sessions| sessions.values().cloned())
                .collect();
            (
                sessions,
                std::mem::take(&mut state.listeners),
                state.engine.take(),
            )
        };
        for session in sessions {
            session.close(CLOSE_GOING_AWAY, SERVER_CLOSING_REASON);
        }
        if let Some(engine) = engine {
            for id in listeners {
                engine.off(id);
            }
        }
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
        let mut state = self.hub.state();
        if let Some(sessions) = state.sessions.get_mut(&self.index) {
            sessions.remove(&self.id);
            if sessions.is_empty() {
                state.sessions.remove(&self.index);
            }
        }
    }
}
