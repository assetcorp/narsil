use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use super::{Inner, lock, now_ms};
use crate::allocator::Table;
use crate::constants::ALLOCATION_DEBOUNCE_MS;
use crate::coordinator::NodeRegistration;

pub(crate) struct DepartureRun {
    now: f64,
    registered: HashSet<String>,
    referenced: HashSet<String>,
    retained: HashSet<String>,
}

impl DepartureRun {
    pub(crate) fn start(nodes: &[NodeRegistration]) -> DepartureRun {
        DepartureRun {
            now: now_ms(),
            registered: nodes.iter().map(|node| node.node_id.clone()).collect(),
            referenced: HashSet::new(),
            retained: HashSet::new(),
        }
    }
}

fn copy_holders_of(table: &Table) -> Vec<String> {
    let mut holders: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for assignment in table.assignments.values() {
        for holder in assignment.primary.iter().chain(assignment.replicas.iter()) {
            if seen.insert(holder.clone()) {
                holders.push(holder.clone());
            }
        }
    }
    holders
}

impl Inner {
    pub(super) fn retained_nodes_for(
        &self,
        run: &mut DepartureRun,
        table: &Table,
    ) -> HashSet<String> {
        let delay = self.config.node_left_delay_ms as f64;
        let mut retained = HashSet::new();
        let mut state = lock(&self.state);
        for node_id in copy_holders_of(table) {
            if run.registered.contains(&node_id) {
                continue;
            }
            run.referenced.insert(node_id.clone());
            let departed_at = *state.departed_at.entry(node_id.clone()).or_insert(run.now);
            if run.now - departed_at < delay {
                retained.insert(node_id.clone());
                run.retained.insert(node_id);
            }
        }
        retained
    }

    pub(super) fn finish_departure_run(self: &Arc<Self>, run: DepartureRun) {
        let delay = self.config.node_left_delay_ms as f64;
        let sequence = self.next_sequence();
        let mut state = lock(&self.state);
        state.departed_at.retain(|node_id, departed_at| {
            run.referenced.contains(node_id) || run.now - *departed_at < delay
        });
        if let Some((_, timer)) = state.departure.take() {
            timer.abort();
        }
        let next_expiry = run
            .retained
            .iter()
            .filter_map(|node_id| state.departed_at.get(node_id))
            .map(|departed_at| departed_at + delay)
            .fold(f64::INFINITY, f64::min);
        if !next_expiry.is_finite() {
            return;
        }
        let wait = Duration::from_millis((next_expiry - now_ms()).max(0.0) as u64);
        let inner = Arc::clone(self);
        state.departure = Some((
            sequence,
            tokio::spawn(async move {
                tokio::time::sleep(wait).await;
                {
                    let mut state = lock(&inner.state);
                    if state.departure.as_ref().map(|(queued, _)| *queued) != Some(sequence) {
                        return;
                    }
                    state.departure = None;
                }
                inner.schedule_allocation(ALLOCATION_DEBOUNCE_MS);
            }),
        ));
    }
}
