use std::sync::Arc;

use super::WatcherContext;
use super::state::{Abort, AwaitedAdmission, PartitionKey, WatcherState};
use crate::allocator::{ACTIVE, Assignment, INITIALISING, MIGRATING};
use crate::constants::{ADMISSION_TIMEOUT_MS, BOOTSTRAP_RESTART_DELAY_MS};
use crate::controller::lock;

pub(super) enum AfterBootstrap {
    Settled,
    Restart,
    AwaitAdmission(u64),
}

pub(super) fn after_replica_sync(
    state: &mut WatcherState,
    key: &PartitionKey,
    primary_node_id: &str,
    primary_term: f64,
) -> AfterBootstrap {
    let Some(tracked) = state.tracked.get(key) else {
        return AfterBootstrap::Settled;
    };
    if tracked.in_sync {
        return AfterBootstrap::Settled;
    }
    if tracked.primary_node_id.as_deref() != Some(primary_node_id)
        || tracked.primary_term != primary_term
    {
        return AfterBootstrap::Restart;
    }
    state.next_bootstrap_id += 1;
    let id = state.next_bootstrap_id;
    state.awaited.insert(
        key.clone(),
        AwaitedAdmission {
            id,
            primary_node_id: primary_node_id.to_string(),
            primary_term,
        },
    );
    AfterBootstrap::AwaitAdmission(id)
}

pub(super) fn settle_awaited(
    state: &mut WatcherState,
    key: &PartitionKey,
    assignment: &Assignment,
    node_id: &str,
) {
    let Some(awaited) = state.awaited.get(key) else {
        return;
    };
    let awaited_still = assignment.is_primary(&awaited.primary_node_id)
        && assignment.primary_term == awaited.primary_term
        && assignment.holds_replica(node_id)
        && !assignment.holds_in_sync(node_id);
    if !awaited_still {
        state.forget_awaited(key);
    }
}

fn syncs_toward_primary(assignment: &Assignment, node_id: &str) -> bool {
    assignment
        .primary
        .as_deref()
        .is_some_and(|primary| primary != node_id)
        && assignment.holds_replica(node_id)
        && !assignment.holds_in_sync(node_id)
}

pub(super) fn replica_needs_resync(
    state: &WatcherState,
    key: &PartitionKey,
    assignment: &Assignment,
    node_id: &str,
) -> bool {
    assignment.state == ACTIVE
        && syncs_toward_primary(assignment, node_id)
        && !state.bootstraps.contains_key(key)
        && !state.awaited.contains_key(key)
}

impl WatcherContext {
    pub(super) async fn wait_for_admission(self: Arc<Self>, key: PartitionKey, id: u64) {
        let mut stopping = Abort::new(self.stopping.subscribe());
        if !stopping.pause(ADMISSION_TIMEOUT_MS).await {
            return;
        }
        {
            let mut state = lock(&self.state);
            if state
                .awaited
                .get(&key)
                .is_none_or(|awaited| awaited.id != id)
            {
                return;
            }
            state.forget_awaited(&key);
        }
        self.restart_while_out_of_sync(key).await;
    }

    pub(super) async fn restart_while_out_of_sync(self: Arc<Self>, key: PartitionKey) {
        let mut stopping = Abort::new(self.stopping.subscribe());
        loop {
            if !stopping.pause(BOOTSTRAP_RESTART_DELAY_MS).await {
                return;
            }
            let table = match self.live_table(&key.0).await {
                Ok(table) => table,
                Err(error) => {
                    if !stopping.is_aborted() {
                        self.report(&error);
                    }
                    continue;
                }
            };
            let Some(assignment) = table
                .as_ref()
                .and_then(|table| table.assignments.get(f64::from(key.1)))
            else {
                return;
            };
            let bootstrappable =
                [ACTIVE, INITIALISING, MIGRATING].contains(&assignment.state.as_str());
            if !bootstrappable || !syncs_toward_primary(assignment, &self.node_id) {
                return;
            }
            let Some(primary_node_id) = assignment.primary.clone() else {
                return;
            };
            {
                let state = lock(&self.state);
                if state.bootstraps.contains_key(&key) || state.awaited.contains_key(&key) {
                    return;
                }
            }
            self.start_bootstrap(key, primary_node_id, assignment.primary_term);
            return;
        }
    }
}
