use std::collections::{HashMap, HashSet};

use super::assignment::{Assignment, Assignments, INITIALISING, UNASSIGNED};
use super::weight::count_primary_assignments;
use crate::ordering::utf16_order;

pub(crate) struct LostNodes<'a> {
    pub(crate) active: &'a HashSet<String>,
    pub(crate) retained: &'a HashSet<String>,
    pub(crate) shares: &'a [(String, f64)],
    pub(crate) draining: &'a HashSet<String>,
}

impl LostNodes<'_> {
    fn is_active(&self, node_id: &str) -> bool {
        self.active.contains(node_id)
    }
}

pub(crate) fn share_of(shares: &[(String, f64)], node_id: &str) -> f64 {
    match shares.iter().find(|(id, _)| id == node_id) {
        Some((_, share)) if *share > 0.0 => *share,
        _ => 1.0,
    }
}

fn primary_load_of(node_id: &str, counts: &HashMap<String, f64>, shares: &[(String, f64)]) -> f64 {
    counts.get(node_id).copied().unwrap_or(0.0) / share_of(shares, node_id)
}

pub(crate) fn least_loaded_candidate(
    candidates: &[String],
    counts: &HashMap<String, f64>,
    shares: &[(String, f64)],
) -> Option<String> {
    let mut best: Option<&String> = None;
    for candidate in candidates {
        let Some(current) = best else {
            best = Some(candidate);
            continue;
        };
        let best_load = primary_load_of(current, counts, shares);
        let candidate_load = primary_load_of(candidate, counts, shares);
        if candidate_load < best_load
            || (candidate_load == best_load && utf16_order(candidate, current).is_lt())
        {
            best = Some(candidate);
        }
    }
    best.cloned()
}

fn distinct_push(entries: &mut Vec<String>, node_id: &str) {
    if !entries.iter().any(|id| id == node_id) {
        entries.push(node_id.to_string());
    }
}

fn mark_unassigned(
    assignment: &mut Assignment,
    last_primary: Option<&str>,
    last_in_sync: &[String],
) {
    let mut holders: Vec<String> = Vec::new();
    for holder in assignment.last_holders_of() {
        distinct_push(&mut holders, holder);
    }
    for holder in last_in_sync {
        distinct_push(&mut holders, holder);
    }
    if let Some(primary) = last_primary {
        distinct_push(&mut holders, primary);
    }
    holders.sort();
    assignment.primary = None;
    assignment.replicas.clear();
    assignment.in_sync_set.clear();
    assignment.last_holders = Some(holders);
    assignment.state = UNASSIGNED.to_string();
    assignment.removing_replicas = None;
}

fn add_primary(counts: &mut HashMap<String, f64>, node_id: &str) {
    *counts.entry(node_id.to_string()).or_insert(0.0) += 1.0;
}

fn promotion_candidate(
    assignment: &Assignment,
    lost: &LostNodes<'_>,
    counts: &HashMap<String, f64>,
) -> Option<String> {
    let in_sync: Vec<String> = assignment
        .replicas
        .iter()
        .filter(|id| assignment.holds_in_sync(id))
        .cloned()
        .collect();
    let staying: Vec<String> = in_sync
        .iter()
        .filter(|id| !lost.draining.contains(*id) && !assignment.is_removing(id))
        .cloned()
        .collect();
    least_loaded_candidate(&staying, counts, lost.shares)
        .or_else(|| least_loaded_candidate(&in_sync, counts, lost.shares))
}

fn never_reached_active(assignment: &Assignment) -> bool {
    assignment.state == INITIALISING && assignment.last_holders_of().is_empty()
}

fn restart_as_empty_copy(
    assignment: &mut Assignment,
    lost: &LostNodes<'_>,
    counts: &mut HashMap<String, f64>,
) {
    let placeable = |id: &str| lost.is_active(id) && !lost.draining.contains(id);
    let mut others: Vec<String> = lost
        .active
        .iter()
        .filter(|id| placeable(id) && !assignment.holds_replica(id))
        .cloned()
        .collect();
    others.sort();
    let held: Vec<String> = assignment
        .replicas
        .iter()
        .filter(|id| placeable(id))
        .cloned()
        .collect();
    let chosen = least_loaded_candidate(&held, counts, lost.shares)
        .or_else(|| least_loaded_candidate(&others, counts, lost.shares));
    let Some(chosen) = chosen else {
        return;
    };
    add_primary(counts, &chosen);
    assignment
        .replicas
        .retain(|id| *id != chosen && lost.is_active(id));
    assignment.primary = Some(chosen);
    assignment.in_sync_set.clear();
    assignment.primary_term += 1.0;
    assignment.last_holders = None;
    assignment.removing_replicas = None;
}

fn keep_removing_replicas_held(assignment: &mut Assignment) {
    let removing: Vec<String> = assignment
        .removing_replicas
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|id| assignment.holds_replica(id))
        .cloned()
        .collect();
    assignment.removing_replicas = (!removing.is_empty()).then_some(removing);
}

fn handle_assignment(
    assignment: &mut Assignment,
    lost: &LostNodes<'_>,
    counts: &mut HashMap<String, f64>,
) {
    if assignment.state == UNASSIGNED {
        return;
    }
    let last_primary = assignment.primary.clone();
    let last_in_sync = assignment.in_sync_set.clone();
    let primary_was_lost = last_primary
        .as_deref()
        .is_some_and(|primary| !lost.is_active(primary));
    if primary_was_lost && never_reached_active(assignment) {
        restart_as_empty_copy(assignment, lost, counts);
        return;
    }
    if primary_was_lost {
        assignment.primary = None;
    }
    assignment
        .replicas
        .retain(|id| lost.is_active(id) || lost.retained.contains(id));
    assignment.in_sync_set.retain(|id| lost.is_active(id));
    keep_removing_replicas_held(assignment);
    if !primary_was_lost {
        if assignment.primary.is_none() {
            mark_unassigned(assignment, last_primary.as_deref(), &last_in_sync);
        }
        return;
    }
    let Some(promoted) = promotion_candidate(assignment, lost, counts) else {
        mark_unassigned(assignment, last_primary.as_deref(), &last_in_sync);
        return;
    };
    add_primary(counts, &promoted);
    assignment.replicas.retain(|id| *id != promoted);
    assignment.in_sync_set.retain(|id| *id != promoted);
    assignment.primary = Some(promoted);
    if let Some(previous) = last_primary.filter(|previous| lost.retained.contains(previous)) {
        assignment.replicas.push(previous);
    }
    keep_removing_replicas_held(assignment);
    assignment.primary_term += 1.0;
}

pub(crate) fn handle_lost_nodes(assignments: &mut Assignments, lost: &LostNodes<'_>) {
    let mut counts = count_primary_assignments(assignments);
    for assignment in assignments.values_mut() {
        handle_assignment(assignment, lost, &mut counts);
    }
}
