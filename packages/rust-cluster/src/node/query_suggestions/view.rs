use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use narsil::suggestions_host::SuggestionState;
use narsil::{Map, Value};

use crate::controller::{lock, read_index_metadata_snapshot};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::coordinator::{IndexMetadataEvent, SchemaEvent};
use crate::error::ClusterResult;
use crate::rebalance::is_hidden_generation;

const DEFAULT_LANGUAGE: &str = "english";

pub(crate) struct ClusterSuggestionIndex {
    pub(crate) state: Arc<SuggestionState>,
    pub(crate) schema: Map,
    pub(crate) language: String,
    pub(crate) index_uuid: String,
    pub(crate) has_sync: bool,
    pub(crate) replication_factor: u32,
}

pub(crate) trait SuggestionViewEvents: Send + Sync {
    fn on_gone(&self, index_name: &str);
    fn on_setting_changed(
        &self,
        index_name: &str,
        previous: &SuggestionState,
        next: &SuggestionState,
    );
    fn on_error(&self, error: &crate::error::ClusterError);
}

pub(crate) struct ClusterSuggestionView {
    coordinator: Arc<EtcdCoordinator>,
    events: Arc<dyn SuggestionViewEvents>,
    held: Mutex<HashMap<String, Arc<ClusterSuggestionIndex>>>,
    turns: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    watches: Mutex<Vec<WatchHandle>>,
    stopped: AtomicBool,
}

fn sync_enabled(settings: &Map) -> bool {
    matches!(settings.get("sync"), Some(Value::Object(sync)) if sync.get("enabled") == Some(&Value::Bool(true)))
}

async fn read_index(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<ClusterSuggestionIndex>> {
    let Some(snapshot) = read_index_metadata_snapshot(coordinator, index_name).await? else {
        return Ok(None);
    };
    let Some(Value::Object(schema)) = coordinator.schema(index_name).await? else {
        return Ok(None);
    };
    let settings = snapshot.settings.unwrap_or_default();
    let language = match settings.get("language") {
        Some(Value::String(language)) => language.clone(),
        _ => DEFAULT_LANGUAGE.to_string(),
    };
    Ok(Some(ClusterSuggestionIndex {
        state: Arc::new(SuggestionState::from_settings(&settings)?),
        schema,
        language,
        index_uuid: snapshot.record.index_uuid,
        has_sync: sync_enabled(&settings),
        replication_factor: snapshot.record.replication_factor as u32,
    }))
}

impl ClusterSuggestionView {
    pub(crate) fn new(
        coordinator: Arc<EtcdCoordinator>,
        events: Arc<dyn SuggestionViewEvents>,
    ) -> ClusterSuggestionView {
        ClusterSuggestionView {
            coordinator,
            events,
            held: Mutex::new(HashMap::new()),
            turns: Mutex::new(HashMap::new()),
            watches: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(true),
        }
    }

    pub(crate) fn get(&self, index_name: &str) -> Option<Arc<ClusterSuggestionIndex>> {
        lock(&self.held).get(index_name).cloned()
    }

    pub(crate) fn names(&self) -> Vec<String> {
        lock(&self.held).keys().cloned().collect()
    }

    async fn reread(&self, index_name: &str) -> ClusterResult<Option<Arc<ClusterSuggestionIndex>>> {
        let previous = self.get(index_name);
        let next = read_index(&self.coordinator, index_name)
            .await?
            .map(Arc::new);
        if self.stopped.load(Ordering::Acquire) {
            return Ok(next);
        }
        let Some(next) = next else {
            lock(&self.held).remove(index_name);
            if previous.is_some() {
                self.events.on_gone(index_name);
            }
            return Ok(None);
        };
        lock(&self.held).insert(index_name.to_string(), Arc::clone(&next));
        let empty = SuggestionState::default();
        let before = previous.as_ref().map_or(&empty, |index| &*index.state);
        if *before != *next.state {
            self.events
                .on_setting_changed(index_name, before, &next.state);
        }
        Ok(Some(next))
    }

    pub(crate) async fn refresh(
        &self,
        index_name: &str,
    ) -> ClusterResult<Option<Arc<ClusterSuggestionIndex>>> {
        if is_hidden_generation(index_name) {
            return Ok(None);
        }
        let turn = Arc::clone(lock(&self.turns).entry(index_name.to_string()).or_default());
        let reread = {
            let _held = turn.lock().await;
            self.reread(index_name).await
        };
        let mut turns = lock(&self.turns);
        if Arc::strong_count(&turn) == 2 {
            turns.remove(index_name);
        }
        reread
    }

    fn on_change(self: &Arc<Self>, index_name: String) {
        if self.stopped.load(Ordering::Acquire) || is_hidden_generation(&index_name) {
            return;
        }
        let view = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = view.refresh(&index_name).await {
                view.events.on_error(&error);
            }
        });
    }

    pub(crate) async fn start(self: &Arc<Self>) -> ClusterResult<()> {
        if !self.stopped.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let weak: Weak<ClusterSuggestionView> = Arc::downgrade(self);
        let metadata_watch = self
            .coordinator
            .watch_index_metadata(move |event: IndexMetadataEvent| {
                if let Some(view) = weak.upgrade() {
                    view.on_change(event.index_name);
                }
            })
            .await?;
        lock(&self.watches).push(metadata_watch);
        let weak: Weak<ClusterSuggestionView> = Arc::downgrade(self);
        let schema_watch = self
            .coordinator
            .watch_schemas(move |event: SchemaEvent| {
                let index_name = match event {
                    SchemaEvent::Created { index_name, .. }
                    | SchemaEvent::Dropped { index_name } => index_name,
                };
                if let Some(view) = weak.upgrade() {
                    view.on_change(index_name);
                }
            })
            .await?;
        lock(&self.watches).push(schema_watch);
        for index_name in self.coordinator.list_schemas().await? {
            if self.stopped.load(Ordering::Acquire) {
                return Ok(());
            }
            if !is_hidden_generation(&index_name)
                && let Err(error) = self.refresh(&index_name).await
            {
                self.events.on_error(&error);
            }
        }
        Ok(())
    }

    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        for watch in lock(&self.watches).drain(..) {
            watch.stop();
        }
        lock(&self.held).clear();
    }
}
