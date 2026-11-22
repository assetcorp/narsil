use std::collections::{HashMap, HashSet};

use narsil::{Map, Value};
use tokio::task::JoinHandle;

use super::now_ms;
use crate::coordinator::etcd::WatchHandle;
use crate::coordinator::{NodeEvent, NodeRegistration};

const VOLATILE_REGISTRATION_FIELDS: [&str; 2] = ["memory", "partitionBytes"];

pub(crate) type Timer = Option<(u64, JoinHandle<()>)>;

#[derive(Default)]
pub(crate) struct LoopState {
    pub(crate) known_indexes: Vec<String>,
    pub(crate) placement_by_node: HashMap<String, String>,
    pub(crate) departed_at: HashMap<String, f64>,
    pub(crate) debounce: Timer,
    pub(crate) departure: Timer,
    pub(crate) holder_retry: Timer,
    pub(crate) indexes_awaiting_holders: HashSet<String>,
    pub(crate) schemas_listed: bool,
    pub(crate) teardowns: HashMap<String, (u64, JoinHandle<()>)>,
    pub(crate) watches: Vec<WatchHandle>,
    pub(crate) listening: bool,
}

fn abort(timer: &mut Timer) {
    if let Some((_, handle)) = timer.take() {
        handle.abort();
    }
}

impl LoopState {
    pub(crate) fn clear(&mut self) -> Vec<WatchHandle> {
        self.placement_by_node.clear();
        abort(&mut self.debounce);
        abort(&mut self.departure);
        abort(&mut self.holder_retry);
        self.indexes_awaiting_holders.clear();
        self.schemas_listed = false;
        for (_, (_, handle)) in self.teardowns.drain() {
            handle.abort();
        }
        self.departed_at.clear();
        self.listening = false;
        std::mem::take(&mut self.watches)
    }

    pub(crate) fn know_index(&mut self, index_name: &str) {
        if !self.known_indexes.iter().any(|known| known == index_name) {
            self.known_indexes.push(index_name.to_string());
        }
    }

    pub(crate) fn forget_index(&mut self, index_name: &str) {
        self.known_indexes.retain(|known| known != index_name);
        self.indexes_awaiting_holders.remove(index_name);
    }

    pub(crate) fn await_holders(&mut self, index_name: &str, ask_again: bool) {
        if ask_again {
            self.indexes_awaiting_holders.insert(index_name.to_string());
        } else {
            self.indexes_awaiting_holders.remove(index_name);
        }
    }

    pub(crate) fn changes_topology(&mut self, event: &NodeEvent) -> bool {
        match event {
            NodeEvent::Left(node_id) => {
                self.placement_by_node.remove(node_id);
                self.departed_at.insert(node_id.clone(), now_ms());
                true
            }
            NodeEvent::Joined(registration) => {
                self.departed_at.remove(&registration.node_id);
                let placement = placement_of(registration);
                if self.placement_by_node.get(&registration.node_id) == Some(&placement) {
                    return false;
                }
                self.placement_by_node
                    .insert(registration.node_id.clone(), placement);
                true
            }
        }
    }
}

fn placement_of(registration: &NodeRegistration) -> String {
    let mut placement = Map::new();
    placement.insert("nodeId", Value::String(registration.node_id.clone()));
    placement.insert("address", Value::String(registration.address.clone()));
    placement.insert(
        "roles",
        Value::Array(
            registration
                .roles
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    let mut capacity = Map::new();
    capacity.insert(
        "memoryBytes",
        Value::Number(registration.capacity.memory_bytes),
    );
    capacity.insert("cpuCores", Value::Number(registration.capacity.cpu_cores));
    capacity.insert(
        "diskBytes",
        registration
            .capacity
            .disk_bytes
            .map_or(Value::Null, Value::Number),
    );
    placement.insert("capacity", Value::Object(capacity));
    placement.insert("startedAt", Value::String(registration.started_at.clone()));
    placement.insert("version", Value::String(registration.version.clone()));
    for (name, value) in registration.extra.iter() {
        if !VOLATILE_REGISTRATION_FIELDS.contains(&name.as_str()) {
            placement.insert(name.clone(), value.clone());
        }
    }
    Value::Object(placement).to_json()
}
