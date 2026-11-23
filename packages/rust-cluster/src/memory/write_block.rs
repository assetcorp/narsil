use std::collections::{BTreeSet, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use narsil::Value;

use crate::allocator::{Table, memory_is_full};
use crate::controller::lock;
use crate::coordinator::NodeEvent;
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::error::{ClusterError, ClusterResult, codes};

const NODE_MEMORY_FULL_REASON: &str = "node_memory_full";

pub(crate) struct NodeMemoryView {
    coordinator: Arc<EtcdCoordinator>,
    local_node_id: String,
    local_full: Arc<AtomicBool>,
    registered_full: Arc<Mutex<HashSet<String>>>,
    unwatch: Mutex<Option<WatchHandle>>,
}

fn record(registered_full: &Mutex<HashSet<String>>, node_id: String, full: bool) {
    let mut registered = lock(registered_full);
    if full {
        registered.insert(node_id);
    } else {
        registered.remove(&node_id);
    }
}

impl NodeMemoryView {
    pub(crate) fn new(
        coordinator: Arc<EtcdCoordinator>,
        local_node_id: String,
        local_full: Arc<AtomicBool>,
    ) -> NodeMemoryView {
        NodeMemoryView {
            coordinator,
            local_node_id,
            local_full,
            registered_full: Arc::new(Mutex::new(HashSet::new())),
            unwatch: Mutex::new(None),
        }
    }

    pub(crate) fn full_node_ids(&self) -> BTreeSet<String> {
        let mut full_node_ids: BTreeSet<String> = lock(&self.registered_full)
            .iter()
            .filter(|node_id| **node_id != self.local_node_id)
            .cloned()
            .collect();
        if self.local_full.load(Ordering::Acquire) {
            full_node_ids.insert(self.local_node_id.clone());
        }
        full_node_ids
    }

    pub(crate) async fn start(&self) -> ClusterResult<()> {
        if lock(&self.unwatch).is_some() {
            return Ok(());
        }
        let reported_by_watch: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let (reported, registered_full) = (
            Arc::clone(&reported_by_watch),
            Arc::clone(&self.registered_full),
        );
        let handle = self
            .coordinator
            .watch_nodes(move |event| {
                let (node_id, full) = match event {
                    NodeEvent::Joined(registration) => {
                        let full = memory_is_full(&registration);
                        (registration.node_id, full)
                    }
                    NodeEvent::Left(node_id) => (node_id, false),
                };
                lock(&reported).insert(node_id.clone());
                record(&registered_full, node_id, full);
            })
            .await?;
        if let Some(previous) = lock(&self.unwatch).replace(handle) {
            previous.stop();
        }
        let listed = match self.coordinator.list_nodes().await {
            Ok(listed) => listed,
            Err(error) => {
                self.stop();
                return Err(error);
            }
        };
        for node in listed {
            if !lock(&reported_by_watch).contains(&node.node_id) {
                let full = memory_is_full(&node);
                record(&self.registered_full, node.node_id, full);
            }
        }
        Ok(())
    }

    pub(crate) fn stop(&self) {
        if let Some(handle) = lock(&self.unwatch).take() {
            handle.stop();
        }
        lock(&self.registered_full).clear();
    }
}

fn copy_holders_of(table: &Table) -> BTreeSet<&str> {
    let mut holders = BTreeSet::new();
    for assignment in table.assignments.values() {
        if let Some(primary) = &assignment.primary {
            holders.insert(primary.as_str());
        }
        for replica in &assignment.replicas {
            holders.insert(replica.as_str());
        }
    }
    holders
}

pub(crate) fn find_write_block(
    table: &Table,
    view: Option<&NodeMemoryView>,
) -> Option<ClusterError> {
    let full_node_ids = view?.full_node_ids();
    if full_node_ids.is_empty() {
        return None;
    }
    let blocking_node_ids: Vec<&str> = copy_holders_of(table)
        .into_iter()
        .filter(|node_id| full_node_ids.contains(*node_id))
        .collect();
    if blocking_node_ids.is_empty() {
        return None;
    }
    let quoted_node_ids = blocking_node_ids
        .iter()
        .map(|node_id| format!("'{node_id}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let holders = if blocking_node_ids.len() == 1 {
        format!("node {quoted_node_ids} holds a copy of it and reports")
    } else {
        format!("nodes {quoted_node_ids} hold copies of it and report")
    };
    let index_name = table.index_name.as_str();
    Some(
        ClusterError::new(
            codes::CLUSTER_WRITE_BLOCKED,
            format!(
                "Index '{index_name}' refuses inserts and updates because {holders} full memory. Remove documents from the indexes on that node or give it more memory, and writes resume once its memory falls below the resume threshold."
            ),
        )
        .with_detail("reason", Value::from(NODE_MEMORY_FULL_REASON))
        .with_detail("indexName", Value::from(index_name))
        .with_detail(
            "fullNodeIds",
            Value::Array(
                blocking_node_ids
                    .iter()
                    .map(|node_id| Value::from(*node_id))
                    .collect(),
            ),
        ),
    )
}

pub(crate) fn require_writable_index(
    table: &Table,
    view: Option<&NodeMemoryView>,
) -> ClusterResult<()> {
    match find_write_block(table, view) {
        Some(block) => Err(block),
        None => Ok(()),
    }
}
