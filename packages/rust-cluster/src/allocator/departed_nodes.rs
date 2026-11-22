use std::collections::HashSet;

use super::assignment::{Assignment, Assignments, INITIALISING, UNASSIGNED};
use super::lost_nodes::{keep_removing_replicas_held, mark_unassigned, never_reached_active};

fn without_departed(
    assignment: &Assignment,
    registered: &HashSet<String>,
    retained: &HashSet<String>,
) -> Option<Assignment> {
    if assignment.state == UNASSIGNED {
        return None;
    }
    let mut next = assignment.clone();
    let primary_departed = assignment
        .primary
        .as_deref()
        .is_none_or(|primary| !registered.contains(primary));
    if primary_departed {
        if assignment.primary.is_some() && never_reached_active(assignment) {
            return None;
        }
        if assignment.state != INITIALISING {
            next.last_holders = None;
        }
        mark_unassigned(
            &mut next,
            assignment.primary.as_deref(),
            &assignment.in_sync_set,
        );
        return Some(next);
    }
    next.in_sync_set.retain(|id| registered.contains(id));
    next.replicas
        .retain(|id| registered.contains(id) || retained.contains(id));
    if next.in_sync_set.len() == assignment.in_sync_set.len()
        && next.replicas.len() == assignment.replicas.len()
    {
        return None;
    }
    keep_removing_replicas_held(&mut next);
    Some(next)
}

pub(crate) fn assignments_without_departed_nodes(
    assignments: &Assignments,
    registered: &HashSet<String>,
    retained: &HashSet<String>,
) -> Option<Assignments> {
    let changes: Vec<(f64, Assignment)> = assignments
        .iter()
        .filter_map(|(partition_id, assignment)| {
            without_departed(assignment, registered, retained).map(|next| (partition_id, next))
        })
        .collect();
    if changes.is_empty() {
        return None;
    }
    let mut next = assignments.clone();
    for (partition_id, assignment) in changes {
        next.set(partition_id, assignment);
    }
    Some(next)
}
