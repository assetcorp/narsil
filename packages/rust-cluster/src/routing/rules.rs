use narsil::Value;

use super::write::Refused;
use crate::constants::PRIMARY_CHANGE_RETRY_WINDOW_MS;
use crate::data::abandoned_with_term;
use crate::error::{ClusterError, codes};
use crate::payload::forward::WriteCondition;

const FORWARD_INTERRUPTED: &str = "forward_interrupted";
const FORWARD_WINDOW_ENDED: &str = "forward_window_ended";
const INITIALISING: &str = "INITIALISING";
const TRANSPORT_CODE: &str = "transportCode";
const TARGET_NODE_ID: &str = "targetNodeId";

fn detail_text<'a>(error: &'a ClusterError, key: &str) -> Option<&'a str> {
    error.details().get(key).and_then(Value::as_str)
}

fn not_primary(error: &ClusterError) -> bool {
    error.code() == codes::PARTITION_NOT_PRIMARY
}

fn refused_by_primary_change(refused: &Refused, retries_ended_term: bool) -> bool {
    not_primary(&refused.error)
        || (abandoned_with_term(&refused.error)
            && (retries_ended_term || refused.abandoned.is_some()))
}

fn forward_failed_with(error: &ClusterError, transport_code: &str) -> bool {
    detail_text(error, TRANSPORT_CODE) == Some(transport_code)
        && detail_text(error, TARGET_NODE_ID).is_some()
}

pub(super) fn forward_unsent(error: &ClusterError) -> bool {
    error.code() == codes::NODE_NOT_READY
        || forward_failed_with(error, codes::TRANSPORT_CONNECT_FAILED)
}

pub(super) fn forward_interrupted(error: &ClusterError) -> bool {
    forward_failed_with(error, codes::TRANSPORT_PEER_UNAVAILABLE)
}

fn refused_for_another_index(error: &ClusterError) -> bool {
    not_primary(error) && detail_text(error, "heldIndexUuid").is_some()
}

fn refused_while_initialising(error: &ClusterError) -> bool {
    not_primary(error) && detail_text(error, "state") == Some(INITIALISING)
}

fn cannot_have_applied(error: &ClusterError) -> bool {
    not_primary(error) || forward_unsent(error)
}

pub(super) fn retried_after_delay(error: &ClusterError) -> bool {
    refused_for_another_index(error)
        || refused_while_initialising(error)
        || forward_unsent(error)
        || forward_interrupted(error)
}

pub(super) fn retriable(refused: &Refused, settles_as_equal: bool) -> bool {
    refused_by_primary_change(refused, settles_as_equal)
        || forward_unsent(&refused.error)
        || (settles_as_equal && forward_interrupted(&refused.error))
}

pub(super) fn next_condition(
    refused: &Refused,
    current: Option<WriteCondition>,
) -> Option<WriteCondition> {
    match &refused.abandoned {
        Some(abandoned) => Some(WriteCondition {
            if_seq_no: abandoned.previous_seq_no,
            if_primary_term: abandoned.previous_primary_term,
            abandoned_seq_no: abandoned.seq_no,
            abandoned_primary_term: abandoned.primary_term,
            compensation_seq_no: abandoned.compensation_seq_no,
        }),
        None => current,
    }
}

#[derive(Debug, Default)]
pub(super) struct History {
    pub(super) may_have_applied: bool,
    interrupted: bool,
    ended_term_before_interruption: Option<ClusterError>,
}

impl History {
    pub(super) fn record(&mut self, error: &ClusterError) {
        if !self.interrupted
            && self.ended_term_before_interruption.is_none()
            && abandoned_with_term(error)
        {
            self.ended_term_before_interruption = Some(error.clone());
        }
        self.interrupted |= forward_interrupted(error);
        self.may_have_applied |= !cannot_have_applied(error);
    }

    pub(super) fn final_error(
        &self,
        index_name: &str,
        document_id: &str,
        error: ClusterError,
    ) -> ClusterError {
        let decided_from_write_record = error.code() == codes::REPLICATION_WRITE_CONFLICT;
        if let Some(ended_term) = self
            .ended_term_before_interruption
            .as_ref()
            .filter(|_| !decided_from_write_record)
        {
            ended_term.clone()
        } else if self.interrupted {
            interrupted_outcome(index_name, document_id, &error)
        } else {
            error
        }
    }
}

fn outcome_unknown(
    message: String,
    index_name: &str,
    document_id: &str,
    reason: &str,
) -> ClusterError {
    ClusterError::new(codes::REPLICATION_OUTCOME_UNKNOWN, message)
        .with_detail("indexName", Value::from(index_name))
        .with_detail("docId", Value::from(document_id))
        .with_detail("reason", Value::from(reason))
}

pub(super) fn window_ended_outcome(index_name: &str, document_id: &str) -> ClusterError {
    outcome_unknown(
        format!(
            "This node stopped waiting for the primary of index '{index_name}' to answer the write to document '{document_id}' once {PRIMARY_CHANGE_RETRY_WINDOW_MS}ms had passed, so the write may or may not have taken effect. Read the document before you retry the write."
        ),
        index_name,
        document_id,
        FORWARD_WINDOW_ENDED,
    )
}

fn interrupted_outcome(index_name: &str, document_id: &str, cause: &ClusterError) -> ClusterError {
    outcome_unknown(
        format!(
            "The connection to the primary of index '{index_name}' failed after this node forwarded the write to document '{document_id}', so the write may or may not have taken effect. Read the document before you retry the write."
        ),
        index_name,
        document_id,
        FORWARD_INTERRUPTED,
    )
    .with_detail("originalError", Value::from(cause.message()))
}

pub(super) fn transport_failure(
    error: ClusterError,
    message: String,
    target_node_id: &str,
) -> ClusterError {
    let code = match error.code() {
        codes::TRANSPORT_CONNECT_FAILED | codes::TRANSPORT_PEER_UNAVAILABLE => {
            codes::QUERY_NO_ACTIVE_REPLICA
        }
        codes::TRANSPORT_TIMEOUT => codes::QUERY_NODE_TIMEOUT,
        codes::TRANSPORT_MESSAGE_TOO_LARGE | codes::TRANSPORT_DECODE_FAILED => {
            codes::QUERY_ROUTING_FAILED
        }
        _ => return error,
    };
    let transport_code = error.code().to_string();
    let mut mapped = ClusterError::new(code, message);
    for (key, value) in error.details().iter() {
        mapped = mapped.with_detail(key, value.clone());
    }
    mapped
        .with_detail(TARGET_NODE_ID, Value::from(target_node_id))
        .with_detail(TRANSPORT_CODE, Value::String(transport_code))
}

pub(super) fn unsent_after(error: &ClusterError) -> ClusterError {
    error
        .clone()
        .with_detail(TRANSPORT_CODE, Value::from(codes::TRANSPORT_CONNECT_FAILED))
}
