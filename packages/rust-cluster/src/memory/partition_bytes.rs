use std::collections::{BTreeMap, HashSet};

use narsil::{Map, Value};

use crate::constants::{
    PARTITION_BYTES_ENTRY_BYTES, PARTITION_BYTES_INDEX_OVERHEAD_BYTES,
    PARTITION_BYTES_REPORT_BUDGET_BYTES,
};

pub(crate) struct PartitionSize {
    pub(crate) index_name: String,
    pub(crate) partition_id: u32,
    pub(crate) bytes: u64,
}

pub(crate) struct HeldIndexSizes {
    pub(crate) index_name: String,
    pub(crate) held: Vec<u32>,
    pub(crate) index_bytes: u64,
    pub(crate) partitions: Vec<(u32, u64, u64)>,
}

pub(crate) fn held_partition_sizes(index: HeldIndexSizes) -> Vec<PartitionSize> {
    let held: HashSet<u32> = index.held.into_iter().collect();
    if held.is_empty() {
        return Vec::new();
    }
    let mut partition_bytes = 0u64;
    let mut documents = 0u64;
    for (_, bytes, document_count) in &index.partitions {
        partition_bytes = partition_bytes.saturating_add(*bytes);
        documents = documents.saturating_add(*document_count);
    }
    let shared_bytes = index.index_bytes.saturating_sub(partition_bytes);
    index
        .partitions
        .into_iter()
        .filter(|(partition_id, _, _)| held.contains(partition_id))
        .map(|(partition_id, bytes, document_count)| {
            let share = if documents > 0 {
                shared_bytes as f64 * document_count as f64 / documents as f64
            } else {
                0.0
            };
            PartitionSize {
                index_name: index.index_name.clone(),
                partition_id,
                bytes: (bytes as f64 + share).round() as u64,
            }
        })
        .collect()
}

fn largest_within_budget(mut sizes: Vec<PartitionSize>) -> Vec<PartitionSize> {
    sizes.sort_by_key(|size| std::cmp::Reverse(size.bytes));
    let mut reported_indexes: HashSet<String> = HashSet::new();
    let mut kept = Vec::new();
    let mut budget_bytes = PARTITION_BYTES_REPORT_BUDGET_BYTES;
    for size in sizes {
        let index_cost = if reported_indexes.contains(&size.index_name) {
            0
        } else {
            PARTITION_BYTES_INDEX_OVERHEAD_BYTES + size.index_name.len() as u64
        };
        let cost = index_cost + PARTITION_BYTES_ENTRY_BYTES;
        if cost > budget_bytes {
            break;
        }
        budget_bytes -= cost;
        reported_indexes.insert(size.index_name.clone());
        kept.push(size);
    }
    kept
}

pub(crate) fn partition_bytes_report(sizes: Vec<PartitionSize>) -> Option<Value> {
    let mut by_index: BTreeMap<String, Vec<(u32, u64)>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for size in largest_within_budget(sizes) {
        let entry = by_index.entry(size.index_name.clone()).or_insert_with(|| {
            order.push(size.index_name.clone());
            Vec::new()
        });
        entry.push((size.partition_id, size.bytes));
    }
    if order.is_empty() {
        return None;
    }
    let mut report = Vec::with_capacity(order.len());
    for index_name in order {
        let mut partitions = by_index.remove(&index_name).unwrap_or_default();
        partitions.sort_by_key(|(partition_id, _)| *partition_id);
        let mut entry = Map::with_capacity(2);
        entry.insert("indexName", Value::String(index_name));
        entry.insert(
            "partitions",
            Value::Array(
                partitions
                    .into_iter()
                    .map(|(partition_id, bytes)| {
                        Value::Array(vec![
                            Value::Number(f64::from(partition_id)),
                            Value::Number(bytes as f64),
                        ])
                    })
                    .collect(),
            ),
        );
        report.push(Value::Object(entry));
    }
    Some(Value::Array(report))
}
