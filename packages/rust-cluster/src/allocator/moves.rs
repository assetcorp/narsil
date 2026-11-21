use std::collections::HashSet;

use super::assignment::{ACTIVE, Assignments};
use super::deciders::{DeciderContext, Deciders};
use super::lost_nodes::least_loaded_candidate;
use super::weight::{compute_node_weights, count_node_assignments, count_primary_assignments};
use super::{NodeMap, Role};
use crate::coordinator::NodeRegistration;

pub(crate) struct Placement<'a> {
    pub(crate) nodes: Vec<&'a NodeRegistration>,
    pub(crate) node_map: &'a NodeMap<'a>,
    pub(crate) deciders: &'a Deciders<'a>,
    pub(crate) draining: &'a HashSet<String>,
}

pub(crate) fn place_replica(
    assignments: &Assignments,
    partition_id: f64,
    placement: &Placement<'_>,
) -> Option<String> {
    let counts = count_node_assignments(assignments);
    let context = DeciderContext {
        partition_id,
        role: Role::Replica,
        current: assignments.get(partition_id),
        all: assignments,
        counts: &counts,
        nodes: placement.node_map,
    };
    let candidates: Vec<String> = placement
        .nodes
        .iter()
        .map(|node| node.node_id.clone())
        .collect();
    let weights = compute_node_weights(&placement.nodes, assignments);
    super::weight::find_best_node(&candidates, &weights, placement.deciders, &context)
}

pub(crate) fn settle_moves(assignments: &mut Assignments, replication_factor: f64) {
    for assignment in assignments.values_mut() {
        let Some(removing) = assignment.removing_replicas.take() else {
            continue;
        };
        let removing: Vec<String> = removing
            .into_iter()
            .filter(|id| assignment.holds_replica(id))
            .collect();
        if removing.is_empty() {
            continue;
        }
        let outside: Vec<String> = assignment
            .replicas
            .iter()
            .filter(|id| !removing.contains(id))
            .cloned()
            .collect();
        let in_sync_outside = outside
            .iter()
            .filter(|id| assignment.holds_in_sync(id))
            .count();
        if in_sync_outside as f64 >= replication_factor {
            assignment.replicas = outside;
            assignment.in_sync_set.retain(|id| !removing.contains(id));
            continue;
        }
        if outside.len() as f64 >= replication_factor {
            assignment.removing_replicas = Some(removing);
        }
    }
}

fn seed_successor(assignments: &mut Assignments, partition_id: f64, placement: &Placement<'_>) {
    let Some(assignment) = assignments.get(partition_id) else {
        return;
    };
    if assignment.removing_replicas.is_some() {
        return;
    }
    if assignment
        .replicas
        .iter()
        .any(|id| !placement.draining.contains(id))
    {
        return;
    }
    let Some(target) = place_replica(assignments, partition_id, placement) else {
        return;
    };
    if let Some(assignment) = assignments.get_mut(partition_id) {
        assignment.replicas.push(target);
    }
}

pub(crate) fn hand_over_draining_leads(
    assignments: &mut Assignments,
    placement: &Placement<'_>,
    shares: &[(String, f64)],
) {
    let mut counts = count_primary_assignments(assignments);
    for partition_id in assignments.ids() {
        let Some(assignment) = assignments.get(partition_id) else {
            continue;
        };
        let Some(leader) = assignment.primary.clone() else {
            continue;
        };
        if assignment.state != ACTIVE || !placement.draining.contains(&leader) {
            continue;
        }
        let staying: Vec<String> = assignment
            .replicas_outside_move()
            .into_iter()
            .filter(|id| assignment.holds_in_sync(id) && !placement.draining.contains(id))
            .collect();
        let Some(successor) = least_loaded_candidate(&staying, &counts, shares) else {
            seed_successor(assignments, partition_id, placement);
            continue;
        };
        *counts.entry(successor.clone()).or_insert(0.0) += 1.0;
        let leader_count = counts.get(&leader).copied().unwrap_or(1.0);
        counts.insert(leader.clone(), leader_count - 1.0);
        let Some(assignment) = assignments.get_mut(partition_id) else {
            continue;
        };
        assignment.replicas.retain(|id| *id != successor);
        assignment.replicas.push(leader.clone());
        assignment
            .in_sync_set
            .retain(|id| *id != successor && *id != leader);
        assignment.in_sync_set.push(leader);
        assignment.primary = Some(successor);
        assignment.primary_term += 1.0;
    }
}

pub(crate) fn move_draining_replicas(
    assignments: &mut Assignments,
    placement: &Placement<'_>,
    replication_factor: f64,
) {
    for partition_id in assignments.ids() {
        let Some(assignment) = assignments.get(partition_id) else {
            continue;
        };
        if assignment.state != ACTIVE || assignment.removing_replicas.is_some() {
            continue;
        }
        let Some(primary) = &assignment.primary else {
            continue;
        };
        if placement.draining.contains(primary) {
            continue;
        }
        let Some(source) = assignment
            .replicas
            .iter()
            .find(|id| placement.draining.contains(*id))
            .cloned()
        else {
            continue;
        };
        let staying = assignment
            .replicas
            .iter()
            .filter(|id| {
                **id != source && assignment.holds_in_sync(id) && !placement.draining.contains(*id)
            })
            .count();
        let target = if (staying as f64) < replication_factor {
            match place_replica(assignments, partition_id, placement) {
                Some(target) => Some(target),
                None => continue,
            }
        } else {
            None
        };
        let Some(assignment) = assignments.get_mut(partition_id) else {
            continue;
        };
        if let Some(target) = target {
            assignment.replicas.push(target);
        }
        assignment.removing_replicas = Some(vec![source]);
    }
}
