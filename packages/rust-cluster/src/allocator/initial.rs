use narsil::{Map, Value};

use super::assignment::{Assignment, Assignments, INITIALISING, Table};
use super::deciders::{DeciderContext, Deciders};
use super::weight::{compute_node_weights, count_node_assignments, find_best_node};
use super::{NodeMap, Role, sorted_by_node_id};
use crate::coordinator::NodeRegistration;
use crate::error::{ClusterError, ClusterResult, codes};

fn starting_assignment(primary: String) -> Assignment {
    Assignment {
        primary: Some(primary),
        replicas: Vec::new(),
        in_sync_set: Vec::new(),
        in_sync_version: None,
        removing_replicas: None,
        last_holders: None,
        state: INITIALISING.to_string(),
        primary_term: 1.0,
        commit_point: 0.0,
        unassigned_reason: None,
        extra: Map::new(),
    }
}

fn place(
    sorted: &[&NodeRegistration],
    node_map: &NodeMap<'_>,
    assignments: &Assignments,
    partition_id: f64,
    role: Role,
    deciders: &Deciders<'_>,
) -> Option<String> {
    let candidates: Vec<String> = sorted.iter().map(|node| node.node_id.clone()).collect();
    let weights = compute_node_weights(sorted, assignments);
    let counts = count_node_assignments(assignments);
    let context = DeciderContext {
        partition_id,
        role,
        current: match role {
            Role::Primary => None,
            Role::Replica => assignments.get(partition_id),
        },
        all: assignments,
        counts: &counts,
        nodes: node_map,
    };
    find_best_node(&candidates, &weights, deciders, &context)
}

pub(crate) fn initial_allocate(
    nodes: &[&NodeRegistration],
    index_name: &str,
    partition_count: f64,
    replication_factor: f64,
    deciders: &Deciders<'_>,
) -> ClusterResult<Table> {
    let sorted = sorted_by_node_id(nodes);
    let node_map = NodeMap::new(&sorted);
    let mut assignments = Assignments::default();
    let mut partition_id = 0.0;
    while partition_id < partition_count {
        let Some(primary) = place(
            &sorted,
            &node_map,
            &assignments,
            partition_id,
            Role::Primary,
            deciders,
        ) else {
            return Err(ClusterError::new(
                codes::ALLOCATION_FAILED,
                format!("No eligible node for primary of partition {partition_id}"),
            )
            .with_detail("partitionId", Value::Number(partition_id))
            .with_detail("role", Value::String("primary".to_string())));
        };
        assignments.set(partition_id, starting_assignment(primary));
        let mut slot = 0.0;
        while slot < replication_factor {
            let Some(replica) = place(
                &sorted,
                &node_map,
                &assignments,
                partition_id,
                Role::Replica,
                deciders,
            ) else {
                break;
            };
            if let Some(assignment) = assignments.get_mut(partition_id) {
                assignment.replicas.push(replica);
            }
            slot += 1.0;
        }
        partition_id += 1.0;
    }
    Ok(Table {
        index_name: index_name.to_string(),
        version: 1.0,
        replication_factor,
        assignments,
        generation: None,
        index_uuid: None,
    })
}
