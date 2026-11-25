use std::collections::HashSet;

use super::admission_wait::{replica_needs_resync, settle_awaited};
use super::state::{Action, PartitionKey, Tracked, WatcherState};
use crate::allocator::{ACTIVE, Assignment, Assignments, INITIALISING, Table, UNASSIGNED};

pub(crate) fn partition_of(partition_id: f64) -> Option<u32> {
    let whole = partition_id.is_finite() && partition_id.fract() == 0.0;
    (whole && partition_id >= 0.0 && partition_id <= f64::from(u32::MAX))
        .then_some(partition_id as u32)
}

fn is_assigned(assignment: &Assignment, node_id: &str) -> bool {
    assignment.is_primary(node_id) || assignment.holds_replica(node_id)
}

fn already_holds_data(assignment: &Assignment, node_id: &str) -> bool {
    assignment.state == ACTIVE
        && (assignment.is_primary(node_id) || assignment.holds_in_sync(node_id))
}

fn serves_partition(assignment: &Assignment, node_id: &str) -> bool {
    assignment.state != INITIALISING
        && assignment.state != UNASSIGNED
        && (assignment.is_primary(node_id) || assignment.holds_in_sync(node_id))
}

fn empty_table_of(table: &Table) -> Table {
    Table {
        index_name: table.index_name.clone(),
        version: table.version,
        replication_factor: table.replication_factor,
        assignments: Assignments::default(),
        generation: table.generation.clone(),
        index_uuid: None,
    }
}

pub(super) fn needs_seeding(state: &WatcherState, index_name: &str) -> bool {
    !state.seeded.contains(index_name)
}

pub(super) fn seed_retained(state: &mut WatcherState, index_name: &str, held: &[u32]) {
    if !state.seeded.insert(index_name.to_string()) {
        return;
    }
    for &partition_id in held {
        state
            .retained
            .insert((index_name.to_string(), partition_id));
    }
}

fn release_earlier_index(
    state: &mut WatcherState,
    node_id: &str,
    table: &Table,
    actions: &mut Vec<Action>,
) {
    let Some(index_uuid) = &table.index_uuid else {
        return;
    };
    let known = state
        .index_uuids
        .insert(table.index_name.clone(), index_uuid.clone());
    if known.is_none_or(|known| known == *index_uuid) {
        return;
    }
    process_table(state, node_id, &empty_table_of(table), actions);
    actions.push(Action::ReleaseTornDown(table.index_name.clone()));
}

fn bootstrap_toward(key: &PartitionKey, primary_node_id: &str, assignment: &Assignment) -> Action {
    Action::Bootstrap {
        key: key.clone(),
        primary_node_id: primary_node_id.to_string(),
        primary_term: assignment.primary_term,
    }
}

fn new_assignment(
    key: &PartitionKey,
    assignment: &Assignment,
    node_id: &str,
    actions: &mut Vec<Action>,
) {
    let Some(primary_node_id) = assignment.primary.as_deref() else {
        return;
    };
    if primary_node_id != node_id {
        actions.push(bootstrap_toward(key, primary_node_id, assignment));
        return;
    }
    if assignment.state == INITIALISING {
        actions.push(bootstrap_toward(key, node_id, assignment));
    }
}

fn existing_assignment(
    state: &mut WatcherState,
    key: &PartitionKey,
    existing: &Tracked,
    assignment: &Assignment,
    node_id: &str,
    actions: &mut Vec<Action>,
) {
    settle_awaited(state, key, assignment, node_id);
    let demoted = existing.is_primary
        && !assignment.is_primary(node_id)
        && assignment.primary_term > existing.primary_term;
    if demoted {
        state.abort_bootstrap(key);
        if !already_holds_data(assignment, node_id)
            && let Some(primary_node_id) = assignment.primary.as_deref()
        {
            actions.push(bootstrap_toward(key, primary_node_id, assignment));
        }
        return;
    }
    let promoted_back = assignment.is_primary(node_id)
        && assignment.state == INITIALISING
        && assignment.primary_term > existing.primary_term;
    if promoted_back {
        actions.push(bootstrap_toward(key, node_id, assignment));
        return;
    }
    if replica_needs_resync(state, key, assignment, node_id)
        && let Some(primary_node_id) = assignment.primary.as_deref()
    {
        actions.push(bootstrap_toward(key, primary_node_id, assignment));
    }
}

fn keeps_copy_for_recovery(table: &Table, partition_id: u32, node_id: &str) -> bool {
    table
        .assignments
        .get(f64::from(partition_id))
        .is_some_and(|assignment| {
            assignment
                .last_holders_of()
                .iter()
                .any(|holder| holder == node_id)
        })
}

fn copy_has_no_further_use(table: &Table, partition_id: u32, node_id: &str) -> bool {
    if table.assignments.is_empty() {
        return true;
    }
    table
        .assignments
        .get(f64::from(partition_id))
        .is_some_and(|assignment| {
            assignment.state == ACTIVE
                && assignment
                    .primary
                    .as_deref()
                    .is_some_and(|primary| primary != node_id)
        })
}

fn remove_dropped_partitions(
    state: &mut WatcherState,
    node_id: &str,
    table: &Table,
    current: &HashSet<PartitionKey>,
    actions: &mut Vec<Action>,
) {
    let dropped: Vec<PartitionKey> = state
        .tracked
        .keys()
        .filter(|key| key.0 == table.index_name && !current.contains(*key))
        .cloned()
        .collect();
    for key in dropped {
        state.tracked.remove(&key);
        state.unserved.remove(&key);
        state.abort_bootstrap(&key);
        state.forget_awaited(&key);
        if keeps_copy_for_recovery(table, key.1, node_id) {
            state.retained.insert(key);
            continue;
        }
        state.retained.remove(&key);
        actions.push(Action::RemovePartition(key));
    }
}

fn release_superseded_copies(
    state: &mut WatcherState,
    node_id: &str,
    table: &Table,
    current: &HashSet<PartitionKey>,
    actions: &mut Vec<Action>,
) {
    let retained: Vec<PartitionKey> = state
        .retained
        .iter()
        .filter(|key| key.0 == table.index_name)
        .cloned()
        .collect();
    for key in retained {
        if current.contains(&key) {
            state.retained.remove(&key);
            continue;
        }
        if !copy_has_no_further_use(table, key.1, node_id) {
            continue;
        }
        state.retained.remove(&key);
        state.forget_awaited(&key);
        actions.push(Action::RemovePartition(key));
    }
}

pub(super) fn process_table(
    state: &mut WatcherState,
    node_id: &str,
    table: &Table,
    actions: &mut Vec<Action>,
) {
    if state.stopped {
        return;
    }
    release_earlier_index(state, node_id, table, actions);
    let mut current = HashSet::new();
    for (partition_id, assignment) in table.assignments.iter() {
        let Some(partition_id) = partition_of(partition_id) else {
            continue;
        };
        if !is_assigned(assignment, node_id) {
            continue;
        }
        let key = (table.index_name.clone(), partition_id);
        current.insert(key.clone());
        match state.tracked.get(&key).cloned() {
            None => new_assignment(&key, assignment, node_id, actions),
            Some(existing) => {
                existing_assignment(state, &key, &existing, assignment, node_id, actions)
            }
        }
        state.tracked.insert(
            key.clone(),
            Tracked {
                is_primary: assignment.is_primary(node_id),
                primary_term: assignment.primary_term,
                primary_node_id: assignment.primary.clone(),
                in_sync: assignment.holds_in_sync(node_id),
            },
        );
        if serves_partition(assignment, node_id) {
            state.unserved.remove(&key);
        } else {
            state.unserved.insert(key.clone());
        }
        if already_holds_data(assignment, node_id) {
            actions.push(Action::HoldPartition(key.clone()));
        }
        if assignment.is_primary(node_id) && assignment.state == ACTIVE {
            actions.push(Action::StartTerm {
                key,
                primary_term: assignment.primary_term,
            });
        }
    }
    remove_dropped_partitions(state, node_id, table, &current, actions);
    release_superseded_copies(state, node_id, table, &current, actions);
}
