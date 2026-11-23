use std::collections::HashMap;

use crate::allocator::{ACTIVE, Assignment, Table};

pub(crate) trait ReplicaSelector: Sync {
    fn select(&self, candidates: &[String], partition_id: u32) -> String;
}

pub(crate) struct RandomSelector;

fn random_below(bound: usize) -> usize {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() || bound == 0 {
        return 0;
    }
    (u64::from_le_bytes(bytes) % bound as u64) as usize
}

impl ReplicaSelector for RandomSelector {
    fn select(&self, candidates: &[String], _partition_id: u32) -> String {
        candidates
            .get(random_below(candidates.len()))
            .cloned()
            .unwrap_or_default()
    }
}

pub(crate) fn collect_active_candidates(assignment: &Assignment) -> Vec<String> {
    if assignment.state != ACTIVE {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    if let Some(primary) = &assignment.primary {
        candidates.push(primary.clone());
    }
    for replica in &assignment.replicas {
        if !assignment.in_sync_set.contains(replica) {
            continue;
        }
        if !candidates.contains(replica) {
            candidates.push(replica.clone());
        }
    }
    candidates.sort();
    candidates
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PartitionRouting {
    pub(crate) node_to_partitions: Vec<(String, Vec<u32>)>,
    pub(crate) copies_by_partition: HashMap<u32, Vec<String>>,
    pub(crate) unavailable_partitions: Vec<u32>,
}

impl PartitionRouting {
    pub(crate) fn add_to_node(&mut self, node_id: &str, partition_id: u32) {
        match self
            .node_to_partitions
            .iter_mut()
            .find(|(held, _)| held == node_id)
        {
            Some((_, partitions)) => partitions.push(partition_id),
            None => self
                .node_to_partitions
                .push((node_id.to_string(), vec![partition_id])),
        }
    }
}

pub(crate) fn copies_in_selection_order(
    assignment: &Assignment,
    selector: &dyn ReplicaSelector,
    partition_id: u32,
) -> Vec<String> {
    let mut remaining = collect_active_candidates(assignment);
    let mut ordered = Vec::with_capacity(remaining.len());
    while !remaining.is_empty() {
        let chosen = selector.select(&remaining, partition_id);
        match remaining.iter().position(|candidate| *candidate == chosen) {
            Some(position) => {
                ordered.push(chosen);
                remaining.remove(position);
            }
            None => {
                ordered.push(chosen);
                ordered.append(&mut remaining);
            }
        }
    }
    ordered
}

pub(crate) fn partition_id_of(partition_id: f64) -> u32 {
    if partition_id.is_finite() && partition_id >= 0.0 && partition_id <= f64::from(u32::MAX) {
        partition_id as u32
    } else {
        u32::MAX
    }
}

pub(crate) fn select_replicas_for_query(
    table: &Table,
    selector: &dyn ReplicaSelector,
) -> PartitionRouting {
    let mut routing = PartitionRouting::default();
    for (partition_id, assignment) in table.assignments.iter() {
        let partition_id = partition_id_of(partition_id);
        let copies = copies_in_selection_order(assignment, selector, partition_id);
        let Some(selected) = copies.first().cloned() else {
            routing.unavailable_partitions.push(partition_id);
            continue;
        };
        routing.copies_by_partition.insert(partition_id, copies);
        routing.add_to_node(&selected, partition_id);
    }
    routing
}
