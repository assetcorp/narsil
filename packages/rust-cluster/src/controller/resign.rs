use std::collections::HashSet;
use std::sync::Arc;

use narsil::Value;

use super::Inner;
use super::insync::INSYNC_QUEUE_KEY;
use super::messages::{
    decoded_fields, integer_field, missing_member_text, partition_answer, read_request, text_field,
};
use super::metadata::index_metadata;
use super::table::{TableWrite, put_allocation_over, rewrite_for_current_index, stored_table};
use crate::allocator::{Assignment, Assignments, LostNodes, UNASSIGNED, handle_lost_nodes};
use crate::constants::{ALLOCATION_DEBOUNCE_MS, INSYNC_CAS_ATTEMPTS};
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};
use crate::transport::Respond;

struct PrimaryResign {
    index_name: String,
    index_uuid: String,
    partition_id: f64,
    primary_term: f64,
}

fn validate_primary_resign(decoded: &Value) -> Option<PrimaryResign> {
    let fields = decoded_fields(decoded)?;
    Some(PrimaryResign {
        index_name: text_field(fields, "indexName")?,
        index_uuid: text_field(fields, "indexUuid")?,
        partition_id: integer_field(fields, "partitionId")?,
        primary_term: integer_field(fields, "primaryTerm")?,
    })
}

fn failed_over(
    assignment: &Assignment,
    resigning_node_id: &str,
    registered: &HashSet<String>,
) -> Option<Assignment> {
    let mut single = Assignments::default();
    single.set(0.0, assignment.clone());
    let active: HashSet<String> = registered
        .iter()
        .filter(|node_id| *node_id != resigning_node_id)
        .cloned()
        .collect();
    let retained = HashSet::from([resigning_node_id.to_string()]);
    let draining = HashSet::new();
    handle_lost_nodes(
        &mut single,
        &LostNodes {
            active: &active,
            retained: &retained,
            shares: &[],
            draining: &draining,
        },
    );
    single.get(0.0).cloned()
}

impl Inner {
    async fn resign(&self, request: &PrimaryResign, source_id: &str) -> ClusterResult<bool> {
        let index_name = request.index_name.as_str();
        let metadata = index_metadata(self.coordinator(), index_name).await?;
        if metadata.is_none_or(|metadata| metadata.index_uuid != request.index_uuid) {
            return Ok(false);
        }
        for _ in 0..INSYNC_CAS_ATTEMPTS {
            let Some(table) = stored_table(self.coordinator(), index_name).await? else {
                return Ok(false);
            };
            let Some(assignment) = table.assignments.get(request.partition_id) else {
                return Ok(false);
            };
            if !assignment.is_primary(source_id)
                || assignment.primary_term != request.primary_term
                || assignment.state == UNASSIGNED
            {
                return Ok(false);
            }
            let registered: HashSet<String> = self
                .coordinator()
                .list_nodes()
                .await?
                .into_iter()
                .map(|node| node.node_id)
                .collect();
            let Some(changed) = failed_over(assignment, source_id, &registered) else {
                return Ok(false);
            };
            let mut next = table.clone();
            next.version = table.version + 1.0;
            next.assignments.set(request.partition_id, changed);
            let Some(next) = rewrite_for_current_index(self.coordinator(), next).await? else {
                return Ok(false);
            };
            let write = TableWrite {
                index_name,
                previous: Some(&table),
                writer_node_id: self.node_id(),
                replica: None,
            };
            if put_allocation_over(self.coordinator(), write, next).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(super) async fn handle_primary_resign(
        self: &Arc<Self>,
        message: TransportMessage,
        respond: Respond,
    ) {
        let request = match read_request(
            &message,
            self.node_id(),
            validate_primary_resign,
            &missing_member_text("PrimaryResignPayload"),
        ) {
            Ok(request) => request,
            Err(refused) => return respond.send(refused).await,
        };
        let inner = Arc::clone(self);
        self.insync_queue.enqueue(INSYNC_QUEUE_KEY, async move {
            let accepted = if inner.is_active() {
                match inner.resign(&request, &message.source_id).await {
                    Ok(accepted) => accepted,
                    Err(_) => return,
                }
            } else {
                false
            };
            let answer = partition_answer(
                message_types::REPLICATION_INSYNC_CONFIRM,
                inner.node_id(),
                &message.request_id,
                &request.index_name,
                request.partition_id,
                accepted,
            );
            respond.send(answer).await;
            if accepted && inner.is_active() {
                inner.schedule_allocation(ALLOCATION_DEBOUNCE_MS);
            }
        });
    }
}
