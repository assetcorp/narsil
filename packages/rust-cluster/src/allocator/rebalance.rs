use std::collections::HashSet;

use super::assignment::{ACTIVE, Assignments, Table, UNASSIGNED};
use super::deciders::{DeciderContext, Deciders};
use super::leadership::{capacity_shares, rebalance_leadership};
use super::lost_nodes::{LostNodes, handle_lost_nodes, share_of};
use super::moves::{
    Placement, hand_over_draining_leads, move_draining_replicas, place_replica, settle_moves,
};
use super::surplus::trim_surplus_replicas;
use super::weight::{NodeWeight, compute_node_weights, count_node_assignments, find_best_node};
use super::{NodeMap, Role, is_draining, sorted_by_node_id};
use crate::constants::REBALANCE_THRESHOLD;
use crate::coordinator::NodeRegistration;
use crate::ordering::comparator_sort;

fn clone_assignments(assignments: &Assignments) -> Assignments {
    let mut cloned = Assignments::default();
    for (partition_id, assignment) in assignments.iter() {
        cloned.set(partition_id, assignment.without_unknown_fields());
    }
    cloned
}

fn fill_replica_slots(assignments: &mut Assignments, placement: &Placement<'_>, factor: f64) {
    for partition_id in assignments.ids() {
        while let Some(assignment) = assignments.get(partition_id) {
            if assignment.primary.is_none()
                || assignment.replicas_outside_move().len() as f64 >= factor
            {
                break;
            }
            let Some(replica) = place_replica(assignments, partition_id, placement) else {
                break;
            };
            if let Some(assignment) = assignments.get_mut(partition_id) {
                assignment.replicas.push(replica);
            }
        }
    }
}

fn move_narrows_gap(most: &NodeWeight, least: &NodeWeight, shares: &[(String, f64)]) -> bool {
    let gap = most.weight - least.weight;
    let after =
        (gap - 1.0 / share_of(shares, &most.node_id) - 1.0 / share_of(shares, &least.node_id))
            .abs();
    after < gap
}

struct ReplicaMove<'a> {
    from: String,
    to: String,
    weights: Vec<NodeWeight>,
    node_map: &'a NodeMap<'a>,
    deciders: &'a Deciders<'a>,
}

fn move_one_replica(
    assignments: &mut Assignments,
    motion: &ReplicaMove<'_>,
    lagging_only: bool,
) -> bool {
    let targets = [motion.to.clone()];
    for partition_id in assignments.ids() {
        let Some(assignment) = assignments.get(partition_id) else {
            continue;
        };
        if assignment.removing_replicas.is_some() || !assignment.holds_replica(&motion.from) {
            continue;
        }
        if lagging_only && assignment.holds_in_sync(&motion.from) {
            continue;
        }
        let counts = count_node_assignments(assignments);
        let context = DeciderContext {
            partition_id,
            role: Role::Replica,
            current: Some(assignment),
            all: assignments,
            counts: &counts,
            nodes: motion.node_map,
        };
        let Some(target) = find_best_node(&targets, &motion.weights, motion.deciders, &context)
        else {
            continue;
        };
        if let Some(assignment) = assignments.get_mut(partition_id) {
            assignment.replicas.push(target);
            assignment.removing_replicas = Some(vec![motion.from.clone()]);
        }
        return true;
    }
    false
}

fn rebalance_for_balance(
    assignments: &mut Assignments,
    placement: &Placement<'_>,
    shares: &[(String, f64)],
) {
    let mut total_slots = 0usize;
    for assignment in assignments.values() {
        if assignment.primary.is_some() {
            total_slots += 1;
        }
        total_slots += assignment.replicas.len();
    }
    for _ in 0..total_slots * 2 {
        let weights = compute_node_weights(&placement.nodes, assignments);
        if weights.len() < 2 {
            break;
        }
        let mut order: Vec<usize> = (0..weights.len()).collect();
        comparator_sort(&mut order, |left, right| {
            weights[*left].weight - weights[*right].weight
        });
        let least = &weights[order[0]];
        let most = &weights[order[order.len() - 1]];
        if most.weight - least.weight < REBALANCE_THRESHOLD
            || !move_narrows_gap(most, least, shares)
        {
            break;
        }
        let motion = ReplicaMove {
            from: most.node_id.clone(),
            to: least.node_id.clone(),
            node_map: placement.node_map,
            deciders: placement.deciders,
            weights,
        };
        let moved = move_one_replica(assignments, &motion, true)
            || move_one_replica(assignments, &motion, false);
        if !moved {
            break;
        }
    }
}

fn prune_in_sync_sets(assignments: &mut Assignments) {
    for assignment in assignments.values_mut() {
        if assignment.state == UNASSIGNED {
            continue;
        }
        let replicas = assignment.replicas.clone();
        assignment.in_sync_set.retain(|id| replicas.contains(id));
    }
    for assignment in assignments.values_mut() {
        let Some(removing) = assignment.removing_replicas.take() else {
            continue;
        };
        let kept: Vec<String> = removing
            .into_iter()
            .filter(|id| assignment.holds_replica(id))
            .collect();
        assignment.removing_replicas = (!kept.is_empty()).then_some(kept);
    }
}

fn clear_recovery_state_on_served_partitions(assignments: &mut Assignments) {
    for assignment in assignments.values_mut() {
        if assignment.state != UNASSIGNED {
            assignment.unassigned_reason = None;
        }
        if assignment.state == ACTIVE {
            assignment.last_holders = None;
        }
    }
}

pub(crate) fn rebalance_allocate(
    nodes: &[&NodeRegistration],
    current: &Table,
    replication_factor: f64,
    deciders: &Deciders<'_>,
    retained: &HashSet<String>,
) -> Table {
    let sorted = sorted_by_node_id(nodes);
    let active: HashSet<String> = sorted.iter().map(|node| node.node_id.clone()).collect();
    let node_map = NodeMap::new(&sorted);
    let draining: HashSet<String> = sorted
        .iter()
        .filter(|node| is_draining(node))
        .map(|node| node.node_id.clone())
        .collect();
    let placement = Placement {
        nodes: sorted
            .iter()
            .filter(|node| !draining.contains(&node.node_id))
            .copied()
            .collect(),
        node_map: &node_map,
        deciders,
        draining: &draining,
    };
    let mut assignments = clone_assignments(&current.assignments);
    let shares = capacity_shares(&sorted);
    let lost = LostNodes {
        active: &active,
        retained,
        shares: &shares,
        draining: &draining,
    };
    handle_lost_nodes(&mut assignments, &lost);
    settle_moves(&mut assignments, replication_factor);
    hand_over_draining_leads(&mut assignments, &placement, &shares);
    trim_surplus_replicas(&mut assignments, &sorted, replication_factor, &draining);
    fill_replica_slots(&mut assignments, &placement, replication_factor);
    move_draining_replicas(&mut assignments, &placement, replication_factor);
    settle_moves(&mut assignments, replication_factor);
    rebalance_for_balance(&mut assignments, &placement, &shares);
    rebalance_leadership(&mut assignments, &shares, &draining);
    prune_in_sync_sets(&mut assignments);
    clear_recovery_state_on_served_partitions(&mut assignments);
    Table {
        index_name: current.index_name.clone(),
        version: current.version + 1.0,
        replication_factor,
        assignments,
        generation: None,
        index_uuid: None,
    }
}
