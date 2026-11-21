use std::collections::{HashMap, HashSet};

use super::assignment::{Assignment, Assignments};
use super::weight::compute_node_weights;
use crate::coordinator::NodeRegistration;
use crate::ordering::utf16_order;

fn weight_of(node_id: &str, weights: &HashMap<String, f64>) -> f64 {
    weights.get(node_id).copied().unwrap_or(f64::INFINITY)
}

fn surplus_candidate(
    assignment: &Assignment,
    weights: &HashMap<String, f64>,
    draining: &HashSet<String>,
) -> Option<usize> {
    let mut chosen: Option<usize> = None;
    for (index, candidate) in assignment.replicas.iter().enumerate() {
        let Some(current_index) = chosen else {
            chosen = Some(index);
            continue;
        };
        let current = &assignment.replicas[current_index];
        let candidate_drains = draining.contains(candidate);
        if candidate_drains != draining.contains(current) {
            if candidate_drains {
                chosen = Some(index);
            }
            continue;
        }
        let candidate_lags = !assignment.holds_in_sync(candidate);
        if candidate_lags != !assignment.holds_in_sync(current) {
            if candidate_lags {
                chosen = Some(index);
            }
            continue;
        }
        let candidate_weight = weight_of(candidate, weights);
        let current_weight = weight_of(current, weights);
        if candidate_weight > current_weight
            || (candidate_weight == current_weight && utf16_order(candidate, current).is_gt())
        {
            chosen = Some(index);
        }
    }
    chosen
}

pub(crate) fn trim_surplus_replicas(
    assignments: &mut Assignments,
    sorted_nodes: &[&NodeRegistration],
    replication_factor: f64,
    draining: &HashSet<String>,
) {
    for partition_id in assignments.ids() {
        while let Some(assignment) = assignments.get(partition_id) {
            if assignment.removing_replicas.is_some() {
                break;
            }
            if assignment
                .primary
                .as_ref()
                .is_some_and(|primary| draining.contains(primary))
            {
                break;
            }
            if assignment.replicas.len() as f64 <= replication_factor {
                break;
            }
            let weights: HashMap<String, f64> = compute_node_weights(sorted_nodes, assignments)
                .into_iter()
                .map(|entry| (entry.node_id, entry.weight))
                .collect();
            let Some(index) = surplus_candidate(assignment, &weights, draining) else {
                break;
            };
            let Some(assignment) = assignments.get_mut(partition_id) else {
                break;
            };
            let removed = assignment.replicas.remove(index);
            assignment.in_sync_set.retain(|id| *id != removed);
        }
    }
}
