use std::sync::Arc;

use narsil::Value;
use narsil::replication::{HeldTerm, ReplicatedEntry};
use tokio::task::JoinSet;

use super::PrimaryWrites;
use super::errors::{authority_changed, insync_removal_failed, superseded_by};
use super::scope::Scope;
use crate::allocator::Assignment;
use crate::constants::{
    CONTROLLER_LEASE_KEY, MAX_FORWARD_BATCH_OPERATIONS, MAX_WIRE_BATCH_BYTES,
    WIRE_BATCH_OVERHEAD_BYTES,
};
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::payload::ack::{acknowledged_seq_no, encode_insync_remove, insync_confirmed};
use crate::payload::entry::{WireEntry, encode_entry_run};

pub(super) fn chunked(entries: &[ReplicatedEntry]) -> Vec<&[ReplicatedEntry]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (at, entry) in entries.iter().enumerate() {
        let entry_bytes = entry.document.as_ref().map_or(0, Vec::len) + WIRE_BATCH_OVERHEAD_BYTES;
        let breaks_run = at > start && entry.seq_no != entries[at - 1].seq_no + 1;
        let overflows = at - start >= MAX_FORWARD_BATCH_OPERATIONS
            || (at > start && bytes + entry_bytes > MAX_WIRE_BATCH_BYTES);
        if breaks_run || overflows {
            chunks.push(&entries[start..at]);
            start = at;
            bytes = 0;
        }
        bytes += entry_bytes;
    }
    if start < entries.len() {
        chunks.push(&entries[start..]);
    }
    chunks
}

pub(super) fn in_sync_targets(assignment: &Assignment, node_id: &str) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for replica in &assignment.in_sync_set {
        if replica != node_id && assignment.holds_replica(replica) && !targets.contains(replica) {
            targets.push(replica.clone());
        }
    }
    targets
}

impl PrimaryWrites {
    pub(super) async fn term_at(&self, scope: &Scope, seq_no: u64) -> Option<u64> {
        if seq_no == 0 {
            return Some(0);
        }
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        if let Some(term) = lock(&partition.log).term_at(seq_no) {
            return Some(term);
        }
        let (name, partition_id) = (scope.index_name.clone(), scope.partition_id);
        match self
            .on_copies(move |copies| copies.held_term(&name, partition_id, seq_no))
            .await
        {
            Ok(HeldTerm::Held(term)) => Some(term),
            _ => None,
        }
    }

    pub(super) async fn send_to_node(
        &self,
        node_id: &str,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let mut failure = None;
        for target in self.view.targets(node_id) {
            match self.transport.send(&target, message.clone()).await {
                Ok(answer) => return Ok(answer),
                Err(error) if error.code() == codes::TRANSPORT_TIMEOUT => return Err(error),
                Err(error) => failure = Some(error),
            }
        }
        Err(failure.unwrap_or_else(|| {
            ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!("Node '{node_id}' has no address to send to"),
            )
        }))
    }

    pub(super) async fn send_entries(
        self: &Arc<Self>,
        scope: &Scope,
        entries: &[ReplicatedEntry],
        targets: &[String],
    ) -> ClusterResult<Vec<(String, bool)>> {
        let (Some(first), Some(last)) = (entries.first(), entries.last()) else {
            return Ok(Vec::new());
        };
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        let previous = self.term_at(scope, first.seq_no.saturating_sub(1)).await;
        let wire: Vec<WireEntry> = entries
            .iter()
            .map(|entry| WireEntry::of(&scope.index_name, scope.partition_id, entry.clone()))
            .collect();
        let payload = encode_entry_run(&wire, scope.index_uuid.as_deref(), previous);
        let message_type = if entries.len() == 1 {
            message_types::REPLICATION_ENTRY
        } else {
            message_types::REPLICATION_ENTRY_BATCH
        };
        let message = self.message(message_type, payload)?;
        let mut sends = JoinSet::new();
        for replica in targets {
            let (writes, message, replica) = (Arc::clone(self), message.clone(), replica.clone());
            let (index_name, partition_id, seq_no) =
                (scope.index_name.clone(), scope.partition_id, last.seq_no);
            sends.spawn(async move {
                let acknowledged = match writes.send_to_node(&replica, &message).await {
                    Ok(answer) => {
                        answer.message_type == message_types::REPLICATION_ACK
                            && acknowledged_seq_no(&answer.payload, &index_name, partition_id)
                                == Some(seq_no)
                    }
                    Err(_) => false,
                };
                (replica, acknowledged)
            });
        }
        let mut answered: Vec<(String, bool)> = targets
            .iter()
            .map(|replica| (replica.clone(), false))
            .collect();
        while let Some(joined) = sends.join_next().await {
            if let Ok((replica, true)) = joined
                && let Some(slot) = answered.iter_mut().find(|(id, _)| *id == replica)
            {
                slot.1 = true;
            }
        }
        Ok(answered)
    }

    pub(super) async fn superseded(&self, scope: &Scope) -> ClusterError {
        let mut changes = self.view.changes();
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        let mut superseding = partition.superseding.subscribe();
        loop {
            if let Some(assignment) = self
                .view
                .held_assignment(&scope.index_name, scope.partition_id)
                && !assignment.is_primary(&self.node_id)
                && assignment.primary_term as u64 > scope.primary_term
            {
                return authority_changed(scope, &self.node_id, Some(&assignment));
            }
            if let Some(newer) = superseding
                .borrow_and_update()
                .as_ref()
                .filter(|newer| newer.primary_term > scope.primary_term)
            {
                return superseded_by(scope, &self.node_id, &newer.node_id, newer.primary_term);
            }
            let changed = tokio::select! {
                changed = changes.changed() => changed.is_ok(),
                changed = superseding.changed() => changed.is_ok(),
            };
            if !changed {
                std::future::pending::<()>().await;
            }
        }
    }

    pub(super) async fn assert_authority(&self, scope: &Scope) -> ClusterResult<()> {
        let table = self.view.read(&scope.index_name).await?;
        let current = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(scope.partition_id)));
        if current.is_some_and(|assignment| {
            assignment.is_primary(&self.node_id)
                && assignment.primary_term as u64 == scope.primary_term
        }) {
            return Ok(());
        }
        Err(authority_changed(scope, &self.node_id, current))
    }

    pub(super) async fn controller_for_removal(&self, scope: &Scope) -> ClusterResult<String> {
        if let Some(controller) = self.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? {
            return Ok(controller);
        }
        self.view.refresh(&scope.index_name).await?;
        self.assert_authority(scope).await?;
        Err(insync_removal_failed(
            scope,
            format!(
                "Failed to remove replicas from in-sync set for index '{}': no active controller lease holder",
                scope.index_name
            ),
            None,
        ))
    }

    pub(super) async fn remove_replica(
        &self,
        scope: &Scope,
        replica_node_id: &str,
        controller_node_id: &str,
    ) -> ClusterResult<()> {
        let payload = encode_insync_remove(
            &scope.index_name,
            scope.partition_id,
            replica_node_id,
            scope.primary_term,
        );
        let message = self.message(message_types::REPLICATION_INSYNC_REMOVE, payload)?;
        let answer = self
            .send_to_node(controller_node_id, &message)
            .await
            .map_err(|error| {
                insync_removal_failed(
                    scope,
                    format!(
                        "Controller '{controller_node_id}' did not answer an in-sync removal request for index '{}' partition {}",
                        scope.index_name, scope.partition_id
                    ),
                    Some(replica_node_id),
                )
                .with_detail("controllerNodeId", Value::from(controller_node_id))
                .with_detail("transportCode", Value::from(error.code()))
            })?;
        if let Some(failure) = answer.failure() {
            return Err(failure);
        }
        if insync_confirmed(&answer.payload) != Some(true) {
            self.view.refresh(&scope.index_name).await?;
            self.assert_authority(scope).await?;
            return Err(insync_removal_failed(
                scope,
                format!(
                    "Controller rejected in-sync removal for replica '{replica_node_id}' of index '{}' partition {}",
                    scope.index_name, scope.partition_id
                ),
                Some(replica_node_id),
            ));
        }
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        lock(&partition.terms)
            .removed
            .insert(replica_node_id.to_string(), scope.primary_term);
        Ok(())
    }

    async fn remove_failed(&self, scope: &Scope, failed: &[String]) -> ClusterResult<()> {
        if failed.is_empty() {
            return Ok(());
        }
        let timeout = self.replication_timeout();
        let removal = async {
            let controller = self.controller_for_removal(scope).await?;
            for replica in failed {
                self.remove_replica(scope, replica, &controller).await?;
            }
            Ok(())
        };
        match tokio::time::timeout(timeout, removal).await {
            Ok(removed) => removed,
            Err(_) => Err(insync_removal_failed(
                scope,
                format!(
                    "Removing failed replicas from the in-sync set of index '{}' partition {} did not finish within {}ms",
                    scope.index_name,
                    scope.partition_id,
                    timeout.as_millis()
                ),
                None,
            )
            .with_detail(
                "failedReplicas",
                Value::Array(failed.iter().map(|id| Value::from(id.as_str())).collect()),
            )
            .with_detail("timeoutMs", Value::from(timeout.as_millis() as u64))),
        }
    }

    pub(super) async fn replicate(
        self: &Arc<Self>,
        scope: &Scope,
        assignment: &Assignment,
        entries: &[ReplicatedEntry],
    ) -> ClusterResult<()> {
        let Some(last) = entries.last() else {
            return Ok(());
        };
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        let targets: Vec<String> = {
            let terms = lock(&partition.terms);
            in_sync_targets(assignment, &self.node_id)
                .into_iter()
                .filter(|replica| !terms.removed_under(replica, scope.primary_term))
                .collect()
        };
        let sent = tokio::select! {
            sent = self.send_entries(scope, entries, &targets) => sent?,
            superseded = self.superseded(scope) => return Err(superseded),
        };
        let failed: Vec<String> = sent
            .into_iter()
            .filter(|(_, acknowledged)| !acknowledged)
            .map(|(replica, _)| replica)
            .collect();
        self.remove_failed(scope, &failed).await?;
        self.assert_authority(scope).await?;
        lock(&partition.log).advance_commit_point(last.seq_no);
        Ok(())
    }
}
