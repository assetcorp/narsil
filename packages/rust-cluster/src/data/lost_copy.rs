use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use narsil::Value;
use tokio::sync::watch;

use super::blocking::off_executor;
use super::copies::LocalCopies;
use super::reconcile::settle_unreadable_indexes;
use super::watcher::partition_of;
use crate::allocator::{Assignment, INITIALISING, Table, UNASSIGNED};
use crate::constants::LOST_COPY_RETRY_MS;
use crate::controller::{belongs_to_another_index, index_metadata};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::{NodeErrorHandler, report_failure};
use crate::transport::BoxFuture;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MissingCopy {
    index_name: String,
    index_uuid: String,
    partition_id: u32,
}

pub(super) struct LostCopyWait<'a> {
    pub(super) node_id: &'a str,
    pub(super) coordinator: &'a EtcdCoordinator,
    pub(super) copies: &'a Arc<LocalCopies>,
    pub(super) on_error: Option<&'a NodeErrorHandler>,
}

fn needs_copy(assignment: &Assignment, node_id: &str) -> bool {
    if !assignment.is_primary(node_id) && !assignment.holds_in_sync(node_id) {
        return false;
    }
    if assignment.state == UNASSIGNED {
        return false;
    }
    assignment.state != INITIALISING || !assignment.last_holders_of().is_empty()
}

fn stopped_waiting(node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::NODE_NOT_JOINED,
        format!(
            "Node '{node_id}' shut down before it registered, while it checked the copies that the cluster assigns to it"
        ),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

fn missing_copy_error(node_id: &str, copy: &MissingCopy) -> ClusterError {
    let MissingCopy {
        index_name,
        partition_id,
        ..
    } = copy;
    ClusterError::new(
        codes::NODE_COPY_MISSING,
        format!(
            "Node '{node_id}' started without its copy of partition {partition_id} of index '{index_name}', which the \
             allocation table assigns to it, so it waits to register until the controller fails that copy over. Start \
             the node on the directory that holds the copy where that directory still exists"
        ),
    )
    .with_detail("indexName", Value::String(index_name.clone()))
    .with_detail("partitionId", Value::from(*partition_id))
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

impl LostCopyWait<'_> {
    async fn missing_of_index(&self, index_name: &str) -> ClusterResult<Vec<MissingCopy>> {
        let Some(stored) = self.coordinator.allocation(index_name).await? else {
            return Ok(Vec::new());
        };
        let table = Table::from_stored(&stored);
        let assigned: Vec<u32> = table
            .assignments
            .iter()
            .filter(|(_, assignment)| needs_copy(assignment, self.node_id))
            .filter_map(|(partition_id, _)| partition_of(partition_id))
            .collect();
        if assigned.is_empty() {
            return Ok(Vec::new());
        }
        let Some(metadata) = index_metadata(self.coordinator, index_name).await? else {
            return Ok(Vec::new());
        };
        if belongs_to_another_index(&table, Some(&metadata.index_uuid)) {
            return Ok(Vec::new());
        }
        if self.coordinator.schema(index_name).await?.is_none() {
            return Ok(Vec::new());
        }
        let copies = Arc::clone(self.copies);
        let (name, uuid) = (index_name.to_string(), metadata.index_uuid.clone());
        let lacking =
            off_executor(move || copies.partitions_without_copy(&name, &uuid, &assigned)).await??;
        Ok(lacking
            .into_iter()
            .map(|partition_id| MissingCopy {
                index_name: index_name.to_string(),
                index_uuid: metadata.index_uuid.clone(),
                partition_id,
            })
            .collect())
    }

    async fn scan(&self) -> (Vec<MissingCopy>, Option<ClusterError>) {
        let index_names = match self.coordinator.list_schemas().await {
            Ok(index_names) => index_names,
            Err(error) => return (Vec::new(), Some(error)),
        };
        let mut missing = Vec::new();
        let mut failure = None;
        for index_name in index_names {
            match self.missing_of_index(&index_name).await {
                Ok(found) => missing.extend(found),
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        (missing, failure)
    }

    pub(super) async fn wait(
        &self,
        stopping: &mut watch::Receiver<bool>,
        stand_for_election: &(dyn Fn() -> BoxFuture<'static, ()> + Sync),
    ) -> ClusterResult<()> {
        let mut reported = HashSet::new();
        let mut last_failure: Option<String> = None;
        loop {
            if *stopping.borrow() {
                return Err(stopped_waiting(self.node_id));
            }
            let attempt = async {
                let settle_failure = settle_unreadable_indexes(self.coordinator, self.copies)
                    .await
                    .err();
                let (missing, scan_failure) = self.scan().await;
                (missing, scan_failure, settle_failure)
            };
            let (missing, scan_failure, settle_failure) = tokio::select! {
                outcome = attempt => outcome,
                _ = stopping.wait_for(|stopped| *stopped) => return Err(stopped_waiting(self.node_id)),
            };
            for copy in &missing {
                if reported.insert(copy.clone()) {
                    report_failure(self.on_error, &missing_copy_error(self.node_id, copy));
                }
            }
            let settled = missing.is_empty() && scan_failure.is_none();
            match scan_failure.or(settle_failure) {
                None => last_failure = None,
                Some(error) => {
                    let text = error.to_string();
                    if last_failure.as_deref() != Some(text.as_str()) {
                        report_failure(self.on_error, &error);
                    }
                    last_failure = Some(text);
                }
            }
            if settled {
                return Ok(());
            }
            stand_for_election().await;
            tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(LOST_COPY_RETRY_MS)) => {}
                _ = stopping.wait_for(|stopped| *stopped) => return Err(stopped_waiting(self.node_id)),
            }
        }
    }
}
