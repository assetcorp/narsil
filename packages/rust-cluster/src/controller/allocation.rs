use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use narsil::Value;

use super::departures::DepartureRun;
use super::metadata::index_metadata;
use super::placement::nodes_for_each_index;
use super::table::{
    TableWrite, belongs_to_another_index, put_allocation_over, stamped_with, stored_table,
};
use super::{Inner, lock};
use crate::allocator::{AllocationRequest, Table, allocate, holds_data_role};
use crate::constants::{ALLOCATION_CAS_ATTEMPTS, ALLOCATION_RETRY_DELAY_MS, HOLDER_RETRY_BASE_MS};
use crate::coordinator::{NodeRegistration, SchemaEvent};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::BoxFuture;
use crate::version::shares_major_version;

fn any_data_node(nodes: &[NodeRegistration]) -> bool {
    nodes.iter().any(holds_data_role)
}

fn compatible(nodes: Vec<NodeRegistration>) -> Vec<NodeRegistration> {
    nodes
        .into_iter()
        .filter(|node| shares_major_version(&node.version))
        .collect()
}

pub(super) fn lost_every_attempt(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!("Allocation for index '{index_name}' lost {ALLOCATION_CAS_ATTEMPTS} compare-and-set attempts"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("attempts", Value::Number(ALLOCATION_CAS_ATTEMPTS as f64))
}

impl Inner {
    pub(super) fn schedule_allocation(self: &Arc<Self>, delay_ms: u64) {
        let due = tokio::time::Instant::now() + Duration::from_millis(delay_ms);
        let sequence = self.next_sequence();
        let inner = Arc::clone(self);
        let mut state = lock(&self.state);
        if state.debounce.is_some() && state.debounce_due.is_some_and(|pending| pending <= due) {
            return;
        }
        if let Some((_, previous)) = state.debounce.take() {
            previous.abort();
        }
        state.debounce_due = Some(due);
        state.debounce = Some((
            sequence,
            tokio::spawn(async move {
                tokio::time::sleep_until(due).await;
                {
                    let mut state = lock(&inner.state);
                    if state.debounce.as_ref().map(|(queued, _)| *queued) != Some(sequence) {
                        return;
                    }
                    state.debounce = None;
                    state.debounce_due = None;
                }
                tokio::spawn(inner.run_all_indexes_task());
            }),
        ));
    }

    fn run_all_indexes_task(self: Arc<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            if self.run_all_indexes().await.is_err() && self.is_active() {
                self.schedule_allocation(ALLOCATION_RETRY_DELAY_MS);
            }
        })
    }

    pub(super) async fn compatible_nodes(&self) -> ClusterResult<Vec<NodeRegistration>> {
        Ok(compatible(self.coordinator().list_nodes().await?))
    }

    fn known_indexes(&self) -> Vec<String> {
        lock(&self.state).known_indexes.clone()
    }

    fn next_unvisited_index(&self, visited: &HashSet<String>) -> Option<String> {
        lock(&self.state)
            .known_indexes
            .iter()
            .find(|index_name| !visited.contains(*index_name))
            .cloned()
    }

    async fn run_all_indexes(self: &Arc<Self>) -> ClusterResult<()> {
        if !self.is_active() {
            return Ok(());
        }
        let schemas_listed = lock(&self.state).schemas_listed;
        if !schemas_listed {
            self.list_known_indexes().await?;
        }
        let registered = self.coordinator().list_nodes().await?;
        if !self.is_active() {
            return Ok(());
        }
        let registered_ids: HashSet<String> =
            registered.iter().map(|node| node.node_id.clone()).collect();
        let nodes = compatible(registered);
        let nodes_for =
            nodes_for_each_index(self.coordinator(), nodes, &self.known_indexes()).await?;
        let mut departures = DepartureRun::start(nodes_for.every_node());
        let mut any_failed = false;
        let mut visited = HashSet::new();
        loop {
            if !self.is_active() {
                return Ok(());
            }
            let Some(index_name) = self.next_unvisited_index(&visited) else {
                break;
            };
            visited.insert(index_name.clone());
            let placeable = nodes_for.for_index(&index_name);
            let placed = if any_data_node(placeable) {
                self.run_for_index(&index_name, placeable, Some(&mut departures))
                    .await
            } else {
                self.fail_over_without_placement(&index_name, &registered_ids, &mut departures)
                    .await
            };
            let outcome = match placed {
                Ok(()) => {
                    self.recover_index_partitions(&index_name, placeable, &mut departures)
                        .await
                }
                Err(error) => Err(error),
            };
            if let Err(error) = outcome {
                any_failed = true;
                self.report(&index_name, &error);
            }
        }
        if !self.is_active() {
            return Ok(());
        }
        self.finish_departure_run(departures);
        self.schedule_holder_retry(HOLDER_RETRY_BASE_MS);
        if any_failed && self.is_active() {
            self.schedule_allocation(ALLOCATION_RETRY_DELAY_MS);
        }
        Ok(())
    }

    pub(super) async fn run_for_index(
        &self,
        index_name: &str,
        nodes: &[NodeRegistration],
        mut departures: Option<&mut DepartureRun>,
    ) -> ClusterResult<()> {
        let no_retained = HashSet::new();
        for _ in 0..ALLOCATION_CAS_ATTEMPTS {
            if !self.is_active() {
                return Ok(());
            }
            let stored = stored_table(self.coordinator(), index_name).await?;
            if !self.is_active() {
                return Ok(());
            }
            let Some(metadata) = index_metadata(self.coordinator(), index_name).await? else {
                return Ok(());
            };
            if !self.is_active() {
                return Ok(());
            }
            let current = stored
                .as_ref()
                .filter(|table| !belongs_to_another_index(table, Some(&metadata.index_uuid)));
            if current.is_some_and(|table| table.generation.is_some()) {
                return Ok(());
            }
            if current.is_none()
                && (self.coordinator().schema(index_name).await?.is_none() || !self.is_active())
            {
                return Ok(());
            }
            let retained = match (current, departures.as_deref_mut()) {
                (Some(table), Some(run)) => self.retained_nodes_for(run, table),
                _ => HashSet::new(),
            };
            let table = allocate(&AllocationRequest {
                nodes,
                current,
                index_name,
                partition_count: metadata.partition_count,
                replication_factor: metadata.replication_factor,
                constraints: &metadata.constraints,
                retained: if current.is_some() {
                    &retained
                } else {
                    &no_retained
                },
            })?;
            if !self.is_active() {
                return Ok(());
            }
            let write = TableWrite {
                index_name,
                previous: stored.as_ref(),
                writer_node_id: self.node_id(),
                replica: None,
            };
            let next = stamped_with(table, Some(&metadata.index_uuid));
            if put_allocation_over(self.coordinator(), write, next).await? {
                return Ok(());
            }
        }
        Err(lost_every_attempt(index_name))
    }

    pub(super) async fn recover_index_partitions(
        &self,
        index_name: &str,
        nodes: &[NodeRegistration],
        departures: &mut DepartureRun,
    ) -> ClusterResult<()> {
        let outcome = self
            .recover_unassigned_partitions(index_name, nodes)
            .await?;
        lock(&self.state).await_holders(index_name, outcome.ask_again);
        if outcome.promoted && any_data_node(nodes) {
            self.run_for_index(index_name, nodes, Some(departures))
                .await?;
        }
        Ok(())
    }

    pub(super) async fn handle_schema_event(
        self: &Arc<Self>,
        event: SchemaEvent,
    ) -> ClusterResult<()> {
        match event {
            SchemaEvent::Created { index_name, .. } => {
                self.handle_schema_created(&index_name).await
            }
            SchemaEvent::Dropped { index_name } => {
                lock(&self.state).forget_index(&index_name);
                self.tear_down(&index_name, 0).await
            }
        }
    }

    async fn handle_schema_created(&self, index_name: &str) -> ClusterResult<()> {
        lock(&self.state).know_index(index_name);
        if !self.is_active() {
            return Ok(());
        }
        let Some(metadata) = index_metadata(self.coordinator(), index_name).await? else {
            return Ok(());
        };
        if !self.is_active() {
            return Ok(());
        }
        let nodes = self.compatible_nodes().await?;
        if !any_data_node(&nodes) || !self.is_active() {
            return Ok(());
        }
        let stored = stored_table(self.coordinator(), index_name).await?;
        if !self.is_active() {
            return Ok(());
        }
        let own: Option<&Table> = stored
            .as_ref()
            .filter(|table| !belongs_to_another_index(table, Some(&metadata.index_uuid)));
        if own.is_some_and(|table| table.generation.is_some()) {
            return Ok(());
        }
        let current = own.filter(|table| !table.assignments.is_empty());
        let nodes_for =
            nodes_for_each_index(self.coordinator(), nodes, &self.known_indexes()).await?;
        let placeable = nodes_for.for_index(index_name);
        if !any_data_node(placeable) || !self.is_active() {
            return Ok(());
        }
        let no_retained = HashSet::new();
        let table = allocate(&AllocationRequest {
            nodes: placeable,
            current,
            index_name,
            partition_count: metadata.partition_count,
            replication_factor: metadata.replication_factor,
            constraints: &metadata.constraints,
            retained: &no_retained,
        })?;
        if !self.is_active() {
            return Ok(());
        }
        let write = TableWrite {
            index_name,
            previous: stored.as_ref(),
            writer_node_id: self.node_id(),
            replica: None,
        };
        if put_allocation_over(
            self.coordinator(),
            write,
            stamped_with(table, Some(&metadata.index_uuid)),
        )
        .await?
        {
            return Ok(());
        }
        self.run_for_index(index_name, placeable, None).await
    }
}
