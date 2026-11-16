mod admission;
mod sending;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;
use tokio::time::Instant;

use super::deferred::DeferredEvents;
use super::delivery::Delivery;
use super::reports::QueueReports;
use super::send::{Destination, SendOutcome};
use super::store::DeliveryStore;
use crate::events::body::now_ms;

pub enum Command {
    Enqueue {
        event_type: String,
        body: String,
    },
    Start(Vec<Delivery>),
    Saved {
        id: String,
        admission: u64,
        written: bool,
    },
    Removed {
        id: String,
        written: bool,
    },
    Sent {
        id: String,
        admission: u64,
        outcome: SendOutcome,
    },
    Close(oneshot::Sender<()>),
}

pub struct QueueConfig {
    pub destination: Arc<Destination>,
    pub events: Option<BTreeSet<String>>,
    pub store: DeliveryStore,
    pub reports: QueueReports,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiting {
    Saving,
    SaveRetry(u64),
    Due(u64),
    Ready,
    Sending,
}

struct Entry {
    delivery: Delivery,
    admission: u64,
    waiting: Waiting,
}

pub struct Queue {
    config: QueueConfig,
    commands: UnboundedSender<Command>,
    entries: HashMap<String, Entry>,
    order: BTreeMap<u64, String>,
    timers: BTreeSet<(u64, u64)>,
    ready: VecDeque<(String, u64)>,
    sends: HashMap<u64, AbortHandle>,
    deferred: DeferredEvents,
    next_sequence: u64,
    next_admission: u64,
    dropped: u64,
    started: bool,
    stopped: bool,
    closed: bool,
}

impl Queue {
    pub fn new(config: QueueConfig, commands: UnboundedSender<Command>) -> Queue {
        Queue {
            config,
            commands,
            entries: HashMap::new(),
            order: BTreeMap::new(),
            timers: BTreeSet::new(),
            ready: VecDeque::new(),
            sends: HashMap::new(),
            deferred: DeferredEvents::default(),
            next_sequence: 0,
            next_admission: 0,
            dropped: 0,
            started: false,
            stopped: false,
            closed: false,
        }
    }

    pub async fn run(mut self, mut commands: UnboundedReceiver<Command>) {
        loop {
            let wake = self.timers.first().map(|(at, _)| *at);
            let wait = Duration::from_millis(wake.unwrap_or(0).saturating_sub(now_ms()));
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return };
                    if let Command::Close(done) = command {
                        self.close().await;
                        while let Ok(late) = commands.try_recv() {
                            self.handle(late);
                        }
                        let _ = done.send(());
                        return;
                    }
                    self.handle(command);
                }
                _ = tokio::time::sleep_until(Instant::now() + wait), if wake.is_some() => self.fire_timers(),
            }
            self.pump();
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Enqueue { event_type, body } => self.enqueue(event_type, body),
            Command::Start(loaded) => self.start(loaded),
            Command::Saved {
                id,
                admission,
                written,
            } => self.saved(&id, admission, written),
            Command::Removed { id, written } => {
                if !written {
                    self.config.reports.persistence_error("remove", &id);
                }
            }
            Command::Sent {
                id,
                admission,
                outcome,
            } => self.sent(&id, admission, outcome),
            Command::Close(done) => {
                let _ = done.send(());
            }
        }
    }

    fn current(&mut self, id: &str, admission: u64) -> Option<&mut Entry> {
        self.entries
            .get_mut(id)
            .filter(|entry| entry.admission == admission)
    }

    async fn close(&mut self) {
        self.closed = true;
        for (_, task) in self.sends.drain() {
            task.abort();
        }
        self.timers.clear();
        self.config.store.flush().await;
    }
}
