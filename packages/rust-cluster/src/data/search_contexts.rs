use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use narsil::Map;
use tokio::task::JoinHandle;

use crate::constants::{SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS, SEARCH_CONTEXT_REAPER_INTERVAL_MS};
use crate::controller::lock;
use crate::coordinator::NodeEvent;
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::error::ClusterResult;
use crate::node::generate_node_id;

pub(crate) struct RankedDocuments {
    pub(crate) documents: HashMap<String, Map>,
    pub(crate) vector_paths: Vec<String>,
}

struct SearchContext {
    coordinator_node_id: String,
    keep_alive: Duration,
    expires_at: Instant,
    ranked: Arc<RankedDocuments>,
}

#[derive(Default)]
pub(crate) struct SearchContexts {
    contexts: Mutex<HashMap<String, SearchContext>>,
    reaper: Mutex<Option<JoinHandle<()>>>,
    departures: Mutex<Option<WatchHandle>>,
}

pub(crate) fn keep_alive_of(requested_ms: u64) -> Duration {
    Duration::from_millis(requested_ms.min(SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS))
}

impl SearchContexts {
    pub(crate) fn open(
        &self,
        coordinator_node_id: &str,
        keep_alive: Duration,
        ranked: RankedDocuments,
    ) -> ClusterResult<String> {
        let context_id = generate_node_id()?;
        let at = Instant::now();
        let mut contexts = lock(&self.contexts);
        contexts.retain(|_, context| context.expires_at > at);
        contexts.insert(
            context_id.clone(),
            SearchContext {
                coordinator_node_id: coordinator_node_id.to_string(),
                keep_alive,
                expires_at: at + keep_alive,
                ranked: Arc::new(ranked),
            },
        );
        Ok(context_id)
    }

    pub(crate) fn read(&self, context_id: &str) -> Option<Arc<RankedDocuments>> {
        let mut contexts = lock(&self.contexts);
        let at = Instant::now();
        let context = contexts.get_mut(context_id)?;
        if context.expires_at <= at {
            contexts.remove(context_id);
            return None;
        }
        context.expires_at = at + context.keep_alive;
        Some(Arc::clone(&context.ranked))
    }

    pub(crate) fn release(&self, context_id: &str) {
        lock(&self.contexts).remove(context_id);
    }

    fn release_coordinator(&self, coordinator_node_id: &str) {
        lock(&self.contexts)
            .retain(|_, context| context.coordinator_node_id != coordinator_node_id);
    }

    fn reap(&self) {
        let at = Instant::now();
        lock(&self.contexts).retain(|_, context| context.expires_at > at);
    }

    pub(crate) async fn start(
        self: &Arc<Self>,
        coordinator: &EtcdCoordinator,
    ) -> ClusterResult<()> {
        let contexts = Arc::downgrade(self);
        let departures = coordinator
            .watch_nodes(move |event| {
                if let (NodeEvent::Left(node_id), Some(contexts)) = (event, contexts.upgrade()) {
                    contexts.release_coordinator(&node_id);
                }
            })
            .await?;
        if let Some(previous) = lock(&self.departures).replace(departures) {
            previous.stop();
        }
        let contexts = Arc::downgrade(self);
        let reaper = tokio::spawn(async move {
            let mut ticks =
                tokio::time::interval(Duration::from_millis(SEARCH_CONTEXT_REAPER_INTERVAL_MS));
            loop {
                ticks.tick().await;
                let Some(contexts) = contexts.upgrade() else {
                    return;
                };
                contexts.reap();
            }
        });
        if let Some(previous) = lock(&self.reaper).replace(reaper) {
            previous.abort();
        }
        Ok(())
    }

    pub(crate) fn stop(&self) {
        if let Some(departures) = lock(&self.departures).take() {
            departures.stop();
        }
        if let Some(reaper) = lock(&self.reaper).take() {
            reaper.abort();
        }
        lock(&self.contexts).clear();
    }
}
