#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

use narsil::{Map, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;

use crate::data_node::{DataNode, eventually};

const FNV_32_OFFSET: u32 = 0x811c_9dc5;
const FNV_32_PRIME: u32 = 0x0100_0193;

pub type Expected = BTreeMap<String, Option<String>>;

pub const NON_ASCII_IDS: [&str; 8] = [
    "café-0", "café-2", "café-9", "日本-1", "日本-2", "🦀-0", "🦀-1", "🦀-4",
];

fn fnv1a(units: impl Iterator<Item = u32>) -> u32 {
    units.fold(FNV_32_OFFSET, |hash, unit| {
        (hash ^ unit).wrapping_mul(FNV_32_PRIME)
    })
}

pub fn fnv1a_partition(document_id: &str, partition_count: u32) -> u32 {
    fnv1a(document_id.bytes().map(u32::from)) % partition_count
}

fn utf16_unit_partition(document_id: &str, partition_count: u32) -> u32 {
    fnv1a(document_id.encode_utf16().map(u32::from)) % partition_count
}

pub fn assert_non_ascii_ids_tell_the_encodings_apart(partition_count: u32) {
    let mut reached = BTreeSet::new();
    let mut widths = BTreeSet::new();
    for document_id in NON_ASCII_IDS {
        let partition = fnv1a_partition(document_id, partition_count);
        assert_ne!(
            partition,
            utf16_unit_partition(document_id, partition_count),
            "{document_id} routes to another partition when hashed over UTF-16 units"
        );
        reached.insert(partition);
        widths.extend(document_id.chars().map(char::len_utf8));
    }
    assert_eq!(reached.len(), partition_count as usize, "{reached:?}");
    assert_eq!(widths, BTreeSet::from([1, 2, 3, 4]), "{widths:?}");
}

pub fn titled(title: &str) -> Map {
    [("title", Value::from(title))].into_iter().collect()
}

fn texts(assignment: &Map, name: &str) -> Vec<String> {
    match assignment.get(name) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn holders_of(assignment: &Map) -> Option<Vec<String>> {
    if assignment.get("state").and_then(Value::as_str) != Some("ACTIVE") {
        return None;
    }
    let primary = assignment.get("primary").and_then(Value::as_str)?;
    let replicas = texts(assignment, "replicas");
    let in_sync = texts(assignment, "inSyncSet");
    if replicas.is_empty() || !replicas.iter().all(|replica| in_sync.contains(replica)) {
        return None;
    }
    let mut holders = vec![primary.to_string()];
    holders.extend(replicas);
    Some(holders)
}

pub async fn holders(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    partition_count: u32,
) -> Option<BTreeMap<u32, Vec<String>>> {
    let table = coordinator
        .allocation(index_name)
        .await
        .expect("etcd answers for the table")?;
    if table.assignments.len() != partition_count as usize {
        return None;
    }
    table
        .assignments
        .iter()
        .map(|(partition_id, assignment)| Some((*partition_id as u32, holders_of(assignment)?)))
        .collect()
}

pub async fn settled_holders(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    partition_count: u32,
) -> BTreeMap<u32, Vec<String>> {
    eventually(
        "every partition is ACTIVE with each replica in sync",
        || async {
            holders(coordinator, index_name, partition_count)
                .await
                .is_some()
        },
    )
    .await;
    holders(coordinator, index_name, partition_count)
        .await
        .expect("every partition is settled")
}

pub fn expected_counts(expected: &Expected, partition_count: u32) -> BTreeMap<u32, u64> {
    let mut counts: BTreeMap<u32, u64> = (0..partition_count)
        .map(|partition| (partition, 0))
        .collect();
    for document_id in expected
        .iter()
        .filter_map(|(document_id, title)| title.as_ref().map(|_| document_id))
    {
        *counts
            .entry(fnv1a_partition(document_id, partition_count))
            .or_default() += 1;
    }
    counts
}

pub async fn copy_difference(
    nodes: &[&DataNode],
    index_name: &str,
    holders: &BTreeMap<u32, Vec<String>>,
    expected: &Expected,
) -> Option<String> {
    let partition_count = holders.len() as u32;
    for (document_id, title) in expected {
        let partition_id = fnv1a_partition(document_id, partition_count);
        let holding = &holders[&partition_id];
        for node in nodes {
            let node_id = node.node.node_id();
            let held = node
                .node
                .local_document(index_name, document_id)
                .await
                .map(|held| {
                    held.and_then(|document| {
                        document
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                });
            let wanted = if holding.iter().any(|holder| holder == node_id) {
                title.clone()
            } else {
                None
            };
            if held.as_ref().ok() != Some(&wanted) {
                return Some(format!(
                    "{node_id} should hold {wanted:?} for {document_id} of partition {partition_id}, and reads {held:?}"
                ));
            }
        }
    }
    None
}
