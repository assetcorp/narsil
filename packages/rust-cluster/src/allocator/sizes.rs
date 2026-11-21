use std::collections::{HashMap, HashSet};

use narsil::Value;

use super::assignment::Assignments;
use crate::constants::{ESTIMATED_PARTITION_BYTES, MAX_SAFE_INTEGER};
use crate::coordinator::NodeRegistration;

struct ReportedSize<'a> {
    index_name: &'a str,
    partition_id: f64,
    bytes: f64,
}

fn is_byte_count(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(bytes)) if bytes.is_finite() && *bytes >= 0.0 => Some(*bytes),
        _ => None,
    }
}

fn is_partition_id(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(id))
            if id.fract() == 0.0 && *id >= 0.0 && *id <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*id)
        }
        _ => None,
    }
}

fn reported_sizes(node: &NodeRegistration) -> Vec<ReportedSize<'_>> {
    let Some(Value::Array(indexes)) = node.extra.get("partitionBytes") else {
        return Vec::new();
    };
    let mut sizes = Vec::new();
    for index in indexes {
        let Value::Object(index) = index else {
            continue;
        };
        let Some(index_name) = index.get("indexName").and_then(Value::as_str) else {
            continue;
        };
        let Some(Value::Array(partitions)) = index.get("partitions") else {
            continue;
        };
        for pair in partitions {
            let Value::Array(pair) = pair else {
                continue;
            };
            let (Some(partition_id), Some(bytes)) =
                (is_partition_id(pair.first()), is_byte_count(pair.get(1)))
            else {
                continue;
            };
            sizes.push(ReportedSize {
                index_name,
                partition_id,
                bytes,
            });
        }
    }
    sizes
}

fn size_key(partition_id: f64) -> u64 {
    if partition_id == 0.0 {
        0
    } else {
        partition_id.to_bits()
    }
}

pub(crate) struct PartitionSizes {
    largest: HashMap<u64, f64>,
    reported: HashMap<String, HashSet<u64>>,
    reported_bytes: HashMap<String, f64>,
}

impl PartitionSizes {
    pub(crate) fn read(nodes: &[NodeRegistration], index_name: &str) -> PartitionSizes {
        let mut largest: HashMap<u64, f64> = HashMap::new();
        let mut reported = HashMap::new();
        let mut reported_bytes = HashMap::new();
        for node in nodes {
            let mut here = HashSet::new();
            let mut total = 0.0;
            for entry in reported_sizes(node) {
                total += entry.bytes;
                if entry.index_name != index_name {
                    continue;
                }
                let key = size_key(entry.partition_id);
                here.insert(key);
                let held = largest.entry(key).or_insert(0.0);
                *held = held.max(entry.bytes);
            }
            reported.insert(node.node_id.clone(), here);
            reported_bytes.insert(node.node_id.clone(), total);
        }
        PartitionSizes {
            largest,
            reported,
            reported_bytes,
        }
    }

    pub(crate) fn size_of(&self, partition_id: f64) -> f64 {
        self.largest
            .get(&size_key(partition_id))
            .copied()
            .unwrap_or(ESTIMATED_PARTITION_BYTES)
    }

    pub(crate) fn reports(&self, node_id: &str, partition_id: f64) -> bool {
        self.reported
            .get(node_id)
            .is_some_and(|held| held.contains(&size_key(partition_id)))
    }

    pub(crate) fn held_bytes_of(&self, node_id: &str, assignments: &Assignments) -> f64 {
        let mut held = self.reported_bytes.get(node_id).copied().unwrap_or(0.0);
        for (partition_id, assignment) in assignments.iter() {
            let holds_copy = assignment.is_primary(node_id) || assignment.holds_replica(node_id);
            if holds_copy && !self.reports(node_id, partition_id) {
                held += self.size_of(partition_id);
            }
        }
        held
    }
}
