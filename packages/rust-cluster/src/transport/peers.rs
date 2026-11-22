use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use narsil::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) trait PeerLink: Clone + Send + Sync + 'static {
    fn is_usable(&self) -> bool;
    fn is_finished(&self) -> bool;
    fn shut_down(&self);
    fn closed(&self) -> impl Future<Output = ()> + Send;
}

type Dialled<L> = watch::Receiver<Option<ClusterResult<L>>>;

enum Peer<L> {
    Connecting {
        dialled: Dialled<L>,
        dial: JoinHandle<()>,
    },
    Ready(L),
}

struct Table<L> {
    closed: bool,
    peers: HashMap<String, Peer<L>>,
    draining: Vec<L>,
}

impl<L: PeerLink> Table<L> {
    fn retire(&mut self, link: L) {
        self.draining.retain(|held| !held.is_finished());
        if !link.is_finished() {
            self.draining.push(link);
        }
    }
}

pub(crate) struct Peers<L> {
    table: Arc<Mutex<Table<L>>>,
    shut_down_message: &'static str,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn shut_down_error(message: &str, target: &str) -> ClusterError {
    ClusterError::new(codes::TRANSPORT_CONNECT_FAILED, message)
        .with_detail("target", Value::String(target.to_string()))
}

async fn settle<L: PeerLink>(
    table: &Mutex<Table<L>>,
    target: String,
    outcome: ClusterResult<L>,
    shut_down_message: &str,
) -> ClusterResult<L> {
    let refused = {
        let mut table = lock(table);
        if !table.closed {
            match &outcome {
                Ok(link) => {
                    let unusable: Vec<Peer<L>> = table
                        .peers
                        .extract_if(
                            |_, peer| matches!(peer, Peer::Ready(held) if !held.is_usable()),
                        )
                        .map(|(_, peer)| peer)
                        .collect();
                    for peer in unusable {
                        if let Peer::Ready(held) = peer {
                            table.retire(held);
                        }
                    }
                    table.peers.insert(target, Peer::Ready(link.clone()));
                }
                Err(_) => {
                    table.peers.remove(&target);
                }
            }
            return outcome;
        }
        shut_down_error(shut_down_message, &target)
    };
    if let Ok(link) = outcome {
        link.shut_down();
        link.closed().await;
    }
    Err(refused)
}

impl<L: PeerLink> Peers<L> {
    pub(crate) fn new(shut_down_message: &'static str) -> Peers<L> {
        Peers {
            table: Arc::new(Mutex::new(Table {
                closed: false,
                peers: HashMap::new(),
                draining: Vec::new(),
            })),
            shut_down_message,
        }
    }

    pub(crate) fn ensure_open(&self, target: &str) -> ClusterResult<()> {
        if lock(&self.table).closed {
            return Err(shut_down_error(self.shut_down_message, target));
        }
        Ok(())
    }

    fn ready_or_dialling<D, F>(&self, target: &str, dial: D) -> ClusterResult<Result<L, Dialled<L>>>
    where
        D: FnOnce() -> F,
        F: Future<Output = ClusterResult<L>> + Send + 'static,
    {
        let mut table = lock(&self.table);
        if table.closed {
            return Err(shut_down_error(self.shut_down_message, target));
        }
        let stale = match table.peers.get(target) {
            Some(Peer::Ready(link)) if link.is_usable() => return Ok(Ok(link.clone())),
            Some(Peer::Connecting { dialled, .. }) if dialled.has_changed().is_ok() => {
                return Ok(Err(dialled.clone()));
            }
            Some(Peer::Ready(stale)) => Some(stale.clone()),
            Some(Peer::Connecting { .. }) | None => None,
        };
        if let Some(stale) = stale {
            table.retire(stale);
        }
        let (announce, dialled) = watch::channel(None);
        let connecting = dial();
        let shared = Arc::clone(&self.table);
        let key = target.to_string();
        let message = self.shut_down_message;
        let dial = tokio::spawn(async move {
            let outcome = connecting.await;
            let settled = settle(&shared, key, outcome, message).await;
            announce.send_replace(Some(settled));
        });
        table.peers.insert(
            target.to_string(),
            Peer::Connecting {
                dialled: dialled.clone(),
                dial,
            },
        );
        Ok(Err(dialled))
    }

    pub(crate) async fn link<D, F>(&self, target: &str, dial: D) -> ClusterResult<L>
    where
        D: FnOnce() -> F,
        F: Future<Output = ClusterResult<L>> + Send + 'static,
    {
        let mut dialled = match self.ready_or_dialling(target, dial)? {
            Ok(link) => return Ok(link),
            Err(dialled) => dialled,
        };
        let outcome = dialled
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|outcome| outcome.clone());
        self.ensure_open(target)?;
        outcome.unwrap_or_else(|| {
            Err(ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!("Failed to connect to '{target}': the connect ended without a result"),
            )
            .with_detail("target", Value::String(target.to_string())))
        })
    }

    pub(crate) async fn shut_down(&self) {
        let (peers, draining) = {
            let mut table = lock(&self.table);
            table.closed = true;
            (
                std::mem::take(&mut table.peers),
                std::mem::take(&mut table.draining),
            )
        };
        let mut dials = Vec::new();
        let mut links = Vec::new();
        for link in draining {
            link.shut_down();
            links.push(link);
        }
        for peer in peers.into_values() {
            match peer {
                Peer::Connecting { dial, .. } => {
                    dial.abort();
                    dials.push(dial);
                }
                Peer::Ready(link) => {
                    link.shut_down();
                    links.push(link);
                }
            }
        }
        for dial in dials {
            let _ = dial.await;
        }
        for link in links {
            link.closed().await;
        }
    }
}
