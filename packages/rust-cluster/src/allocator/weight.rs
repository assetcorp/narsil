use std::collections::HashMap;

use super::Role;
use super::assignment::Assignments;
use super::deciders::{DeciderContext, Deciders, Verdict};
use crate::coordinator::NodeRegistration;
use crate::ordering::{comparator_sort, utf16_difference, utf16_order};

pub(crate) struct NodeWeight {
    pub(crate) node_id: String,
    pub(crate) weight: f64,
    pub(crate) primary_weight: f64,
}

fn add_one(counts: &mut HashMap<String, f64>, node_id: &str) {
    *counts.entry(node_id.to_string()).or_insert(0.0) += 1.0;
}

pub(crate) fn count_node_assignments(assignments: &Assignments) -> HashMap<String, f64> {
    let mut counts = HashMap::new();
    for assignment in assignments.values() {
        if let Some(primary) = &assignment.primary {
            add_one(&mut counts, primary);
        }
        for replica in &assignment.replicas {
            if !assignment.is_removing(replica) {
                add_one(&mut counts, replica);
            }
        }
    }
    counts
}

pub(crate) fn count_primary_assignments(assignments: &Assignments) -> HashMap<String, f64> {
    let mut counts = HashMap::new();
    for assignment in assignments.values() {
        if let Some(primary) = &assignment.primary {
            add_one(&mut counts, primary);
        }
    }
    counts
}

pub(crate) fn compute_node_weights(
    nodes: &[&NodeRegistration],
    assignments: &Assignments,
) -> Vec<NodeWeight> {
    let assignment_counts = count_node_assignments(assignments);
    let primary_counts = count_primary_assignments(assignments);
    let total: f64 = nodes.iter().map(|node| node.capacity.memory_bytes).sum();
    let average = if nodes.is_empty() {
        0.0
    } else {
        total / nodes.len() as f64
    };
    let mut weights: Vec<NodeWeight> = nodes
        .iter()
        .map(|node| {
            let partitions = assignment_counts.get(&node.node_id).copied().unwrap_or(0.0);
            let primaries = primary_counts.get(&node.node_id).copied().unwrap_or(0.0);
            let normalised = if average > 0.0 {
                node.capacity.memory_bytes / average
            } else {
                1.0
            };
            NodeWeight {
                node_id: node.node_id.clone(),
                weight: partitions / normalised,
                primary_weight: primaries / normalised,
            }
        })
        .collect();
    weights.sort_by(|left, right| utf16_order(&left.node_id, &right.node_id));
    weights
}

pub(crate) fn find_best_node(
    candidates: &[String],
    weights: &[NodeWeight],
    deciders: &Deciders<'_>,
    context: &DeciderContext<'_>,
) -> Option<String> {
    let mut by_id: HashMap<&str, &NodeWeight> = HashMap::with_capacity(weights.len());
    for weight in weights {
        by_id.insert(weight.node_id.as_str(), weight);
    }
    let mut sorted: Vec<&String> = candidates.iter().collect();
    comparator_sort(&mut sorted, |left, right| {
        let left_weight = by_id.get(left.as_str());
        let right_weight = by_id.get(right.as_str());
        if context.role == Role::Primary {
            let left_primary = left_weight.map_or(0.0, |weight| weight.primary_weight);
            let right_primary = right_weight.map_or(0.0, |weight| weight.primary_weight);
            if left_primary != right_primary {
                return left_primary - right_primary;
            }
        }
        let left_total = left_weight.map_or(0.0, |weight| weight.weight);
        let right_total = right_weight.map_or(0.0, |weight| weight.weight);
        if left_total != right_total {
            return left_total - right_total;
        }
        utf16_difference(left, right)
    });
    let mut throttled: Option<&String> = None;
    for candidate in sorted {
        match deciders.verdict(context, candidate) {
            Verdict::Yes => return Some(candidate.clone()),
            Verdict::Throttle if throttled.is_none() => throttled = Some(candidate),
            _ => {}
        }
    }
    throttled.cloned()
}
