use std::sync::Arc;

use narsil::Value;

use super::Inner;
use super::messages::{
    decoded_fields, integer_field, missing_member_text, partition_answer, read_request, text_field,
};
use super::table::{TableWrite, put_allocation_over, rewrite_for_current_index, stored_table};
use crate::allocator::{ACTIVE, Assignment, UNASSIGNED};
use crate::constants::{ALLOCATION_DEBOUNCE_MS, INSYNC_CAS_ATTEMPTS};
use crate::coordinator::ExpectedReplicaRegistration;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};
use crate::transport::Respond;

pub(super) const INSYNC_QUEUE_KEY: &str = "";

pub(super) struct InsyncRemoval {
    pub(super) index_name: String,
    pub(super) partition_id: f64,
    pub(super) replica_node_id: String,
    pub(super) primary_term: f64,
}

struct InsyncAdmission {
    removal: InsyncRemoval,
    applied_seq_no: f64,
    commit_point: f64,
    in_sync_version: f64,
    replica_started_at: String,
}

enum Decision {
    Refuse,
    Accept,
    Write(Box<Assignment>),
}

fn validate_removal(decoded: &Value) -> Option<InsyncRemoval> {
    let fields = decoded_fields(decoded)?;
    Some(InsyncRemoval {
        index_name: text_field(fields, "indexName")?,
        partition_id: integer_field(fields, "partitionId")?,
        replica_node_id: text_field(fields, "replicaNodeId")?,
        primary_term: integer_field(fields, "primaryTerm")?,
    })
}

fn non_negative(value: f64) -> Option<f64> {
    (value >= 0.0).then_some(value)
}

fn validate_admission(decoded: &Value) -> Option<InsyncAdmission> {
    let removal = validate_removal(decoded)?;
    let fields = decoded_fields(decoded)?;
    let applied_seq_no = non_negative(integer_field(fields, "appliedSeqNo")?)?;
    let commit_point = non_negative(integer_field(fields, "commitPoint")?)?;
    let in_sync_version = non_negative(integer_field(fields, "inSyncVersion")?)?;
    let replica_started_at =
        text_field(fields, "replicaStartedAt").filter(|text| !text.is_empty())?;
    Some(InsyncAdmission {
        removal,
        applied_seq_no,
        commit_point,
        in_sync_version,
        replica_started_at,
    })
}

fn decide_removal(assignment: &Assignment, replica_node_id: &str) -> Decision {
    if assignment.state == UNASSIGNED {
        return Decision::Refuse;
    }
    let mut next = Box::new(assignment.clone());
    if !assignment.holds_in_sync(replica_node_id) {
        next.in_sync_version = Some(assignment.in_sync_version_of() + 1.0);
        return Decision::Write(next);
    }
    next.in_sync_set
        .retain(|node_id| node_id != replica_node_id);
    Decision::Write(next)
}

fn decide_admission(assignment: &Assignment, request: &InsyncAdmission) -> Decision {
    let replica_node_id = request.removal.replica_node_id.as_str();
    if assignment.state != ACTIVE
        || !assignment.holds_replica(replica_node_id)
        || request.in_sync_version != assignment.in_sync_version_of()
        || request.applied_seq_no < assignment.commit_point
        || request.applied_seq_no < request.commit_point
    {
        return Decision::Refuse;
    }
    let already_in_sync = assignment.holds_in_sync(replica_node_id);
    let commit_point = assignment.commit_point.max(request.commit_point);
    if already_in_sync && commit_point == assignment.commit_point {
        return Decision::Accept;
    }
    let mut next = Box::new(assignment.clone());
    if !already_in_sync {
        next.in_sync_set.push(replica_node_id.to_string());
    }
    next.commit_point = commit_point;
    Decision::Write(next)
}

impl Inner {
    async fn update_insync_set(
        &self,
        request: &InsyncRemoval,
        decide: impl Fn(&Assignment) -> Decision,
        replica: Option<&ExpectedReplicaRegistration>,
    ) -> ClusterResult<bool> {
        let index_name = request.index_name.as_str();
        for _ in 0..INSYNC_CAS_ATTEMPTS {
            let Some(table) = stored_table(self.coordinator(), index_name).await? else {
                return Ok(false);
            };
            let Some(assignment) = table.assignments.get(request.partition_id) else {
                return Ok(false);
            };
            if request.primary_term != assignment.primary_term {
                return Ok(false);
            }
            let changed = match decide(assignment) {
                Decision::Refuse => return Ok(false),
                Decision::Accept => return Ok(true),
                Decision::Write(changed) => changed,
            };
            let mut next = table.clone();
            next.version = table.version + 1.0;
            next.assignments.set(request.partition_id, *changed);
            let Some(next) = rewrite_for_current_index(self.coordinator(), next).await? else {
                return Ok(false);
            };
            let write = TableWrite {
                index_name,
                previous: Some(&table),
                writer_node_id: self.node_id(),
                replica,
            };
            if put_allocation_over(self.coordinator(), write, next).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn sender_may_remove(
        &self,
        request: &InsyncRemoval,
        source_id: &str,
    ) -> ClusterResult<bool> {
        let table = stored_table(self.coordinator(), &request.index_name).await?;
        let Some(assignment) = table
            .as_ref()
            .and_then(|table| table.assignments.get(request.partition_id))
        else {
            return Ok(false);
        };
        if assignment.is_primary(source_id) {
            return Ok(true);
        }
        Ok(source_id == request.replica_node_id && assignment.holds_replica(source_id))
    }

    async fn sender_leads(&self, request: &InsyncRemoval, source_id: &str) -> ClusterResult<bool> {
        let table = stored_table(self.coordinator(), &request.index_name).await?;
        Ok(table
            .as_ref()
            .and_then(|table| table.assignments.get(request.partition_id))
            .is_some_and(|assignment| assignment.is_primary(source_id)))
    }

    async fn admit(&self, request: &InsyncAdmission) -> ClusterResult<bool> {
        let registered = self.coordinator().list_nodes().await?;
        let replica_node_id = &request.removal.replica_node_id;
        let current = registered
            .iter()
            .find(|node| &node.node_id == replica_node_id);
        if current.is_none_or(|node| node.started_at != request.replica_started_at) {
            return Ok(false);
        }
        let expected = ExpectedReplicaRegistration {
            node_id: replica_node_id.clone(),
            started_at: request.replica_started_at.clone(),
        };
        self.update_insync_set(
            &request.removal,
            |assignment| decide_admission(assignment, request),
            Some(&expected),
        )
        .await
    }

    fn confirm(
        &self,
        request: &InsyncRemoval,
        request_id: &str,
        accepted: bool,
    ) -> TransportMessage {
        partition_answer(
            message_types::REPLICATION_INSYNC_CONFIRM,
            self.node_id(),
            request_id,
            &request.index_name,
            request.partition_id,
            accepted,
        )
    }

    pub(super) async fn handle_insync_remove(
        self: &Arc<Self>,
        message: TransportMessage,
        respond: Respond,
    ) {
        let request = match read_request(
            &message,
            self.node_id(),
            validate_removal,
            &missing_member_text("InsyncRemovePayload"),
        ) {
            Ok(request) => request,
            Err(refused) => return respond.send(refused).await,
        };
        let inner = Arc::clone(self);
        self.insync_queue.enqueue(INSYNC_QUEUE_KEY, async move {
            let outcome: ClusterResult<bool> = async {
                if !inner
                    .sender_may_remove(&request, &message.source_id)
                    .await?
                    || !inner.is_active()
                {
                    return Ok(false);
                }
                let replica_node_id = request.replica_node_id.clone();
                inner
                    .update_insync_set(
                        &request,
                        |assignment| decide_removal(assignment, &replica_node_id),
                        None,
                    )
                    .await
            }
            .await;
            if let Ok(accepted) = outcome {
                respond
                    .send(inner.confirm(&request, &message.request_id, accepted))
                    .await;
            }
        });
    }

    pub(super) async fn handle_insync_add(
        self: &Arc<Self>,
        message: TransportMessage,
        respond: Respond,
    ) {
        let request = match read_request(
            &message,
            self.node_id(),
            validate_admission,
            &missing_member_text("InsyncAddPayload"),
        ) {
            Ok(request) => request,
            Err(refused) => return respond.send(refused).await,
        };
        let inner = Arc::clone(self);
        self.insync_queue.enqueue(INSYNC_QUEUE_KEY, async move {
            let outcome: ClusterResult<bool> = async {
                if !inner
                    .sender_leads(&request.removal, &message.source_id)
                    .await?
                    || !inner.is_active()
                {
                    return Ok(false);
                }
                inner.admit(&request).await
            }
            .await;
            let Ok(accepted) = outcome else {
                return;
            };
            respond
                .send(inner.confirm(&request.removal, &message.request_id, accepted))
                .await;
            if accepted && inner.is_active() {
                inner.schedule_allocation(ALLOCATION_DEBOUNCE_MS);
            }
        });
    }
}
