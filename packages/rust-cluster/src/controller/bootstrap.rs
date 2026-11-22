use std::sync::Arc;

use narsil::Value;

use super::Inner;
use super::insync::INSYNC_QUEUE_KEY;
use super::messages::{decoded_fields, integer_field, partition_answer, read_request, text_field};
use super::table::{TableWrite, put_allocation_over, rewrite_for_current_index, stored_table};
use crate::allocator::{ACTIVE, INITIALISING};
use crate::constants::BOOTSTRAP_CAS_ATTEMPTS;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};
use crate::transport::Respond;

const INVALID_BOOTSTRAP_COMPLETE: &str = "Invalid BootstrapCompletePayload: it needs an indexName, a partitionId, a nodeId, and a primaryTerm";

struct BootstrapComplete {
    index_name: String,
    partition_id: f64,
    node_id: String,
    primary_term: f64,
}

fn validate_bootstrap_complete(decoded: &Value) -> Option<BootstrapComplete> {
    let fields = decoded_fields(decoded)?;
    Some(BootstrapComplete {
        index_name: text_field(fields, "indexName").filter(|name| !name.is_empty())?,
        partition_id: integer_field(fields, "partitionId").filter(|id| *id >= 0.0)?,
        node_id: text_field(fields, "nodeId")?,
        primary_term: integer_field(fields, "primaryTerm")?,
    })
}

impl Inner {
    async fn process_bootstrap_complete(&self, report: &BootstrapComplete) -> ClusterResult<bool> {
        let index_name = report.index_name.as_str();
        for _ in 0..BOOTSTRAP_CAS_ATTEMPTS {
            let Some(table) = stored_table(self.coordinator(), index_name).await? else {
                return Ok(false);
            };
            let Some(assignment) = table.assignments.get(report.partition_id) else {
                return Ok(false);
            };
            if report.primary_term != assignment.primary_term
                || !assignment.is_primary(&report.node_id)
                || assignment.state != INITIALISING
            {
                return Ok(false);
            }
            let mut served = assignment.clone();
            served.state = ACTIVE.to_string();
            served.last_holders = None;
            let mut next = table.clone();
            next.version = table.version + 1.0;
            next.assignments.set(report.partition_id, served);
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

    async fn answer_bootstrap_complete(&self, message: &TransportMessage) -> TransportMessage {
        let report = match read_request(
            message,
            self.node_id(),
            validate_bootstrap_complete,
            INVALID_BOOTSTRAP_COMPLETE,
        ) {
            Ok(report) => report,
            Err(refused) => return refused,
        };
        let accepted = self.is_active()
            && message.source_id == report.node_id
            && self
                .process_bootstrap_complete(&report)
                .await
                .unwrap_or(false);
        partition_answer(
            message_types::CLUSTER_BOOTSTRAP_COMPLETE,
            self.node_id(),
            &message.request_id,
            &report.index_name,
            report.partition_id,
            accepted,
        )
    }

    pub(super) fn handle_bootstrap_complete(
        self: &Arc<Self>,
        message: TransportMessage,
        respond: Respond,
    ) {
        let inner = Arc::clone(self);
        self.insync_queue.enqueue(INSYNC_QUEUE_KEY, async move {
            let answer = inner.answer_bootstrap_complete(&message).await;
            respond.send(answer).await;
        });
    }
}
