use std::collections::HashMap;

use narsil::Value;

use super::assignment::{Assignment, Assignments};
use super::sizes::PartitionSizes;
use super::{Constraints, NodeMap, Role, is_draining, memory_is_full, zone_of};
use crate::constants::BALANCE_THROTTLE_FACTOR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    Yes,
    No,
    Throttle,
}

pub(crate) struct DeciderContext<'a> {
    pub(crate) partition_id: f64,
    pub(crate) role: Role,
    pub(crate) current: Option<&'a Assignment>,
    pub(crate) all: &'a Assignments,
    pub(crate) counts: &'a HashMap<String, f64>,
    pub(crate) nodes: &'a NodeMap<'a>,
}

pub(crate) struct Deciders<'a> {
    constraints: &'a Constraints,
    sizes: PartitionSizes,
}

fn draining(context: &DeciderContext<'_>, candidate: &str) -> Verdict {
    match context.nodes.get(candidate) {
        Some(node) if is_draining(node) => Verdict::No,
        _ => Verdict::Yes,
    }
}

fn colocation(context: &DeciderContext<'_>, candidate: &str) -> Verdict {
    let Some(current) = context.current else {
        return Verdict::Yes;
    };
    if current.holds_replica(candidate) {
        return Verdict::No;
    }
    if context.role == Role::Replica && current.is_primary(candidate) {
        return Verdict::No;
    }
    Verdict::Yes
}

fn max_shards(limit: Option<f64>, context: &DeciderContext<'_>, candidate: &str) -> Verdict {
    let Some(limit) = limit else {
        return Verdict::Yes;
    };
    let count = context.counts.get(candidate).copied().unwrap_or(0.0);
    if count >= limit {
        Verdict::No
    } else {
        Verdict::Yes
    }
}

fn capacity(sizes: &PartitionSizes, context: &DeciderContext<'_>, candidate: &str) -> Verdict {
    let Some(node) = context.nodes.get(candidate) else {
        return Verdict::No;
    };
    if node.capacity.memory_bytes == 0.0 || memory_is_full(node) {
        return Verdict::No;
    }
    let added = if sizes.reports(candidate, context.partition_id) {
        0.0
    } else {
        sizes.size_of(context.partition_id)
    };
    let projected = sizes.held_bytes_of(candidate, context.all) + added;
    if projected > node.capacity.memory_bytes {
        Verdict::No
    } else {
        Verdict::Yes
    }
}

fn push_distinct<'v>(zones: &mut Vec<&'v Value>, zone: &'v Value) {
    if !zones.contains(&zone) {
        zones.push(zone);
    }
}

fn zone(attribute: &str, context: &DeciderContext<'_>, candidate: &str) -> Verdict {
    let Some(node) = context.nodes.get(candidate) else {
        return Verdict::No;
    };
    let Some(candidate_zone) = zone_of(node, attribute) else {
        return Verdict::Yes;
    };
    let Some(current) = context.current else {
        return Verdict::Yes;
    };
    let mut assigned = Vec::new();
    let holders = current.primary.iter().chain(current.replicas.iter());
    for holder in holders {
        if let Some(held_zone) = context
            .nodes
            .get(holder)
            .and_then(|node| zone_of(node, attribute))
        {
            push_distinct(&mut assigned, held_zone);
        }
    }
    if !assigned.contains(&candidate_zone) {
        return Verdict::Yes;
    }
    let unrepresented = context
        .nodes
        .all()
        .filter_map(|node| zone_of(node, attribute))
        .any(|zone| !assigned.contains(&zone));
    if unrepresented {
        Verdict::Throttle
    } else {
        Verdict::Yes
    }
}

fn balance(context: &DeciderContext<'_>, candidate: &str) -> Verdict {
    let node_count = context.nodes.len();
    if node_count == 0 {
        return Verdict::Yes;
    }
    let mut total_slots = 0usize;
    for assignment in context.all.values() {
        if assignment.primary.is_some() {
            total_slots += 1;
        }
        total_slots += assignment.replicas.len();
    }
    let ideal = (total_slots as f64 / node_count as f64).ceil();
    let count = context.counts.get(candidate).copied().unwrap_or(0.0);
    if count >= ideal * BALANCE_THROTTLE_FACTOR {
        Verdict::Throttle
    } else {
        Verdict::Yes
    }
}

impl<'a> Deciders<'a> {
    pub(crate) fn new(constraints: &'a Constraints, sizes: PartitionSizes) -> Deciders<'a> {
        Deciders { constraints, sizes }
    }

    pub(crate) fn verdict(&self, context: &DeciderContext<'_>, candidate: &str) -> Verdict {
        let mut throttled = false;
        let mut weigh = |verdict: Verdict| match verdict {
            Verdict::No => true,
            Verdict::Throttle => {
                throttled = true;
                false
            }
            Verdict::Yes => false,
        };
        if weigh(draining(context, candidate))
            || weigh(colocation(context, candidate))
            || weigh(max_shards(
                self.constraints.max_shards_per_node,
                context,
                candidate,
            ))
            || weigh(capacity(&self.sizes, context, candidate))
        {
            return Verdict::No;
        }
        if self.constraints.zone_awareness
            && weigh(zone(&self.constraints.zone_attribute, context, candidate))
        {
            return Verdict::No;
        }
        if weigh(balance(context, candidate)) {
            return Verdict::No;
        }
        if throttled {
            Verdict::Throttle
        } else {
            Verdict::Yes
        }
    }
}
