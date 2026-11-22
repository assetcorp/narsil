use std::collections::{HashMap, HashSet};

use super::assignment::{ACTIVE, Assignments};
use super::lost_nodes::share_of;
use super::weight::count_primary_assignments;
use crate::constants::LEADERSHIP_IMBALANCE_THRESHOLD;
use crate::coordinator::NodeRegistration;

struct Swap {
    partition_id: f64,
    candidate: String,
    candidate_load: f64,
}

fn load_of(node_id: &str, counts: &HashMap<String, f64>, shares: &[(String, f64)]) -> f64 {
    counts.get(node_id).copied().unwrap_or(0.0) / share_of(shares, node_id)
}

fn heaviest_leader<'s>(
    shares: &'s [(String, f64)],
    counts: &HashMap<String, f64>,
    without_handover: &HashSet<String>,
) -> Option<&'s str> {
    let mut heaviest: Option<&str> = None;
    for (node_id, _) in shares {
        if without_handover.contains(node_id) {
            continue;
        }
        let heavier = heaviest.is_none_or(|current| {
            load_of(node_id, counts, shares) > load_of(current, counts, shares)
        });
        if heavier {
            heaviest = Some(node_id);
        }
    }
    heaviest
}

fn find_swap(
    assignments: &Assignments,
    heaviest: &str,
    counts: &HashMap<String, f64>,
    shares: &[(String, f64)],
    excluded: &HashSet<String>,
) -> Option<Swap> {
    let heaviest_load = load_of(heaviest, counts, shares);
    let mut best: Option<Swap> = None;
    for (partition_id, assignment) in assignments.iter() {
        if assignment.state != ACTIVE
            || !assignment.is_primary(heaviest)
            || assignment.removing_replicas.is_some()
        {
            continue;
        }
        for candidate in &assignment.in_sync_set {
            if excluded.contains(candidate) {
                continue;
            }
            let candidate_load = load_of(candidate, counts, shares);
            if heaviest_load - candidate_load < LEADERSHIP_IMBALANCE_THRESHOLD {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|swap| candidate_load < swap.candidate_load)
            {
                best = Some(Swap {
                    partition_id,
                    candidate: candidate.clone(),
                    candidate_load,
                });
            }
        }
    }
    best
}

fn apply_swap(assignments: &mut Assignments, swap: Swap, previous: &str) {
    let Some(assignment) = assignments.get_mut(swap.partition_id) else {
        return;
    };
    assignment.replicas.retain(|id| *id != swap.candidate);
    assignment.replicas.push(previous.to_string());
    assignment
        .in_sync_set
        .retain(|id| *id != swap.candidate && id != previous);
    assignment.in_sync_set.push(previous.to_string());
    assignment.primary = Some(swap.candidate);
    assignment.primary_term += 1.0;
}

pub(crate) fn rebalance_leadership(
    assignments: &mut Assignments,
    shares: &[(String, f64)],
    excluded: &HashSet<String>,
) {
    let mut without_handover = HashSet::new();
    let mut swaps = 0;
    while swaps < assignments.len() {
        swaps += 1;
        let counts = count_primary_assignments(assignments);
        let Some(heaviest) = heaviest_leader(shares, &counts, &without_handover) else {
            return;
        };
        let heaviest = heaviest.to_string();
        match find_swap(assignments, &heaviest, &counts, shares, excluded) {
            None => {
                without_handover.insert(heaviest);
            }
            Some(swap) => apply_swap(assignments, swap, &heaviest),
        }
    }
}

pub(crate) fn capacity_shares(nodes: &[&NodeRegistration]) -> Vec<(String, f64)> {
    let total: f64 = nodes.iter().map(|node| node.capacity.memory_bytes).sum();
    let average = if nodes.is_empty() {
        0.0
    } else {
        total / nodes.len() as f64
    };
    let mut shares: Vec<(String, f64)> = Vec::with_capacity(nodes.len());
    for node in nodes {
        let share = if average > 0.0 {
            node.capacity.memory_bytes / average
        } else {
            1.0
        };
        match shares.iter_mut().find(|(id, _)| *id == node.node_id) {
            Some(slot) => slot.1 = share,
            None => shares.push((node.node_id.clone(), share)),
        }
    }
    shares
}
