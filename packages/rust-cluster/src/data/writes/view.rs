use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use narsil::{Value, decode_msgpack};
use tokio::sync::watch;

use crate::allocator::{Assignment, Table};
use crate::controller::{
    belongs_to_another_index, lock, previous_documents_recorded, records_previous_documents,
};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::coordinator::{NodeEvent, NodeRegistration};
use crate::error::ClusterResult;

fn torn_down(table: &Table) -> bool {
    table.assignments.is_empty() && table.generation.is_none()
}

fn settings_records_previous_documents(metadata: &[u8]) -> bool {
    match decode_msgpack(metadata) {
        Ok(Value::Object(fields)) => previous_documents_recorded(fields.get("settings")),
        _ => true,
    }
}

pub(crate) struct AllocationView {
    coordinator: Arc<EtcdCoordinator>,
    tables: Mutex<HashMap<String, Table>>,
    nodes: Mutex<HashMap<String, NodeRegistration>>,
    nodes_listed: AtomicBool,
    previous_documents: Mutex<HashMap<String, bool>>,
    changed: watch::Sender<u64>,
    watches: Mutex<Vec<WatchHandle>>,
}

impl AllocationView {
    pub(crate) fn new(coordinator: Arc<EtcdCoordinator>) -> AllocationView {
        AllocationView {
            coordinator,
            tables: Mutex::new(HashMap::new()),
            nodes: Mutex::new(HashMap::new()),
            nodes_listed: AtomicBool::new(false),
            previous_documents: Mutex::new(HashMap::new()),
            changed: watch::Sender::new(0),
            watches: Mutex::new(Vec::new()),
        }
    }

    pub(crate) async fn start(self: &Arc<Self>) -> ClusterResult<()> {
        let view = Arc::downgrade(self);
        let nodes = self
            .coordinator
            .watch_nodes(move |event| {
                let Some(view) = view.upgrade() else {
                    return;
                };
                let mut nodes = lock(&view.nodes);
                match event {
                    NodeEvent::Joined(node) => {
                        nodes.insert(node.node_id.clone(), node);
                    }
                    NodeEvent::Left(node_id) => {
                        nodes.remove(&node_id);
                    }
                }
            })
            .await?;
        lock(&self.watches).push(nodes);
        let view = Arc::downgrade(self);
        let metadata = self
            .coordinator
            .watch_index_metadata(move |event| {
                let Some(view) = view.upgrade() else {
                    return;
                };
                let mut recorded = lock(&view.previous_documents);
                match event.metadata {
                    Some(metadata) => {
                        let records = settings_records_previous_documents(&metadata);
                        recorded.insert(event.index_name, records);
                    }
                    None => {
                        recorded.remove(&event.index_name);
                    }
                }
            })
            .await?;
        lock(&self.watches).push(metadata);
        let registered = self.coordinator.list_nodes().await?;
        let mut nodes = lock(&self.nodes);
        for node in registered {
            nodes.entry(node.node_id.clone()).or_insert(node);
        }
        drop(nodes);
        self.nodes_listed.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) async fn registered_nodes(&self) -> ClusterResult<Vec<NodeRegistration>> {
        if self.nodes_listed.load(Ordering::Acquire) {
            return Ok(lock(&self.nodes).values().cloned().collect());
        }
        self.coordinator.list_nodes().await
    }

    pub(crate) fn stop(&self) {
        self.nodes_listed.store(false, Ordering::Release);
        for watch in lock(&self.watches).drain(..) {
            watch.stop();
        }
    }

    pub(crate) fn observe(&self, table: &Table) -> Table {
        let mut tables = lock(&self.tables);
        if let Some(held) = tables.get(&table.index_name)
            && held.version > table.version
            && !torn_down(held)
            && !belongs_to_another_index(held, table.index_uuid.as_deref())
        {
            return held.clone();
        }
        tables.insert(table.index_name.clone(), table.clone());
        drop(tables);
        self.changed
            .send_modify(|count| *count = count.wrapping_add(1));
        table.clone()
    }

    pub(crate) async fn read_live(&self, index_name: &str) -> ClusterResult<Option<Table>> {
        let Some(stored) = self.coordinator.allocation(index_name).await? else {
            lock(&self.tables).remove(index_name);
            return Ok(None);
        };
        Ok(Some(self.observe(&Table::from_stored(&stored))))
    }

    pub(crate) async fn refresh(&self, index_name: &str) -> ClusterResult<Option<Table>> {
        match self.read_live(index_name).await {
            Ok(table) => Ok(table),
            Err(error) => match lock(&self.tables).get(index_name) {
                Some(held) => Ok(Some(held.clone())),
                None => Err(error),
            },
        }
    }

    pub(crate) async fn read(&self, index_name: &str) -> ClusterResult<Option<Table>> {
        let held = lock(&self.tables)
            .get(index_name)
            .filter(|held| !torn_down(held))
            .cloned();
        match held {
            Some(held) => Ok(Some(held)),
            None => self.refresh(index_name).await,
        }
    }

    pub(super) fn held_assignment(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> Option<Assignment> {
        lock(&self.tables)
            .get(index_name)
            .and_then(|table| table.assignments.get(f64::from(partition_id)))
            .cloned()
    }

    pub(super) fn changes(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    pub(crate) fn targets(&self, node_id: &str) -> Vec<String> {
        match lock(&self.nodes)
            .get(node_id)
            .map(|node| node.address.as_str())
        {
            Some(address) if !address.is_empty() && address != node_id => {
                vec![address.to_string(), node_id.to_string()]
            }
            _ => vec![node_id.to_string()],
        }
    }

    pub(super) async fn records_previous_documents(&self, index_name: &str) -> bool {
        if let Some(records) = lock(&self.previous_documents).get(index_name).copied() {
            return records;
        }
        let records = records_previous_documents(&self.coordinator, index_name).await;
        *lock(&self.previous_documents)
            .entry(index_name.to_string())
            .or_insert(records)
    }
}
