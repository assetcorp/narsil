use std::sync::{Arc, Weak};

use super::{Inner, lock};
use crate::constants::ALLOCATION_DEBOUNCE_MS;
use crate::coordinator::etcd::WatchHandle;
use crate::coordinator::{NodeEvent, SchemaEvent};
use crate::error::ClusterResult;

fn schema_index_name(event: &SchemaEvent) -> &str {
    match event {
        SchemaEvent::Created { index_name, .. } | SchemaEvent::Dropped { index_name } => index_name,
    }
}

impl Inner {
    fn keep_watch(&self, watch: WatchHandle) {
        if !self.is_active() {
            watch.stop();
            return;
        }
        lock(&self.state).watches.push(watch);
    }

    fn on_node_event(self: &Arc<Self>, event: &NodeEvent) {
        if lock(&self.state).changes_topology(event) {
            self.schedule_allocation(ALLOCATION_DEBOUNCE_MS);
        }
    }

    fn on_schema_event(self: &Arc<Self>, event: SchemaEvent) {
        let index_name = schema_index_name(&event).to_string();
        let inner = Arc::clone(self);
        self.schema_queues.enqueue(&index_name, async move {
            let index_name = schema_index_name(&event).to_string();
            if let Err(error) = inner.handle_schema_event(event).await {
                inner.report(&index_name, &error);
            }
        });
    }

    async fn watch_cluster(self: &Arc<Self>) -> ClusterResult<()> {
        let nodes_owner: Weak<Inner> = Arc::downgrade(self);
        let nodes = self
            .coordinator()
            .watch_nodes(move |event| {
                if let Some(inner) = nodes_owner.upgrade() {
                    inner.on_node_event(&event);
                }
            })
            .await?;
        self.keep_watch(nodes);
        let schemas_owner: Weak<Inner> = Arc::downgrade(self);
        let schemas = self
            .coordinator()
            .watch_schemas(move |event| {
                if let Some(inner) = schemas_owner.upgrade() {
                    inner.on_schema_event(event);
                }
            })
            .await?;
        self.keep_watch(schemas);
        Ok(())
    }

    pub(super) async fn list_known_indexes(&self) -> ClusterResult<()> {
        let index_names = self.coordinator().list_schemas().await?;
        let mut state = lock(&self.state);
        for index_name in &index_names {
            state.know_index(index_name);
        }
        state.schemas_listed = true;
        Ok(())
    }

    pub(super) async fn start_event_loop(self: &Arc<Self>) -> ClusterResult<()> {
        self.clear_event_loop();
        if let Err(error) = self.watch_cluster().await {
            self.clear_event_loop();
            return Err(error);
        }
        let _ = self.list_known_indexes().await;
        if self.is_active() {
            lock(&self.state).listening = true;
        }
        self.schedule_allocation(ALLOCATION_DEBOUNCE_MS);
        Ok(())
    }
}
