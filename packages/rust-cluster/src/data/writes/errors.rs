use narsil::Value;

use super::scope::Scope;
use crate::allocator::Assignment;
use crate::error::{ClusterError, codes};
use crate::payload::forward::ForwardKind;

pub(super) const TERM_ENDED: &str = "term_ended";
pub(super) const ROLLBACK_OPEN: &str = "rollback_open";
pub(super) const LEASE_LAPSED: &str = "lease_lapsed";
const INITIALISING_STATE: &str = "INITIALISING";

fn optional_text(text: Option<&str>) -> Value {
    text.map_or(Value::Null, Value::from)
}

pub(super) fn no_longer_leads(scope: &Scope, node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_NOT_PRIMARY,
        format!(
            "Node '{node_id}' no longer leads partition {} of index '{}'",
            scope.partition_id, scope.index_name
        ),
    )
    .with_detail("indexName", Value::from(scope.index_name.as_str()))
    .with_detail("partitionId", Value::from(scope.partition_id))
    .with_detail("localNodeId", Value::from(node_id))
}

pub(super) fn stopped_leading(
    index_name: &str,
    partition_id: u32,
    node_id: &str,
    primary: Option<&str>,
) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_NOT_PRIMARY,
        format!(
            "Node '{node_id}' stopped leading partition {partition_id} of index '{index_name}' while the write waited"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("partitionId", Value::from(partition_id))
    .with_detail("primaryNodeId", optional_text(primary))
    .with_detail("localNodeId", Value::from(node_id))
}

pub(super) fn initialising_refusal(
    index_name: &str,
    partition_id: u32,
    node_id: &str,
) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_NOT_PRIMARY,
        format!(
            "Node '{node_id}' takes no write for partition {partition_id} of index '{index_name}' until the partition is ACTIVE"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("partitionId", Value::from(partition_id))
    .with_detail("primaryNodeId", Value::from(node_id))
    .with_detail("localNodeId", Value::from(node_id))
    .with_detail("state", Value::from(INITIALISING_STATE))
}

pub(super) fn ended_term(scope: &Scope, node_id: &str, accepted: u64) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_NOT_PRIMARY,
        format!(
            "Node '{node_id}' has accepted term {accepted} for partition {} of index '{}', so it appends nothing under term {}",
            scope.partition_id, scope.index_name, scope.primary_term
        ),
    )
    .with_detail("indexName", Value::from(scope.index_name.as_str()))
    .with_detail("partitionId", Value::from(scope.partition_id))
    .with_detail("localNodeId", Value::from(node_id))
    .with_detail("expectedPrimaryTerm", Value::from(scope.primary_term))
    .with_detail("currentPrimaryTerm", Value::from(accepted))
}

fn changed_authority(
    scope: &Scope,
    node_id: &str,
    current: Option<&Assignment>,
    message: String,
) -> ClusterError {
    let primary = optional_text(current.and_then(|assignment| assignment.primary.as_deref()));
    let term = current.map_or(Value::Null, |assignment| {
        Value::Number(assignment.primary_term)
    });
    authority_moved(scope, node_id, primary, term, message)
}

fn authority_moved(
    scope: &Scope,
    node_id: &str,
    primary: Value,
    primary_term: Value,
    message: String,
) -> ClusterError {
    ClusterError::new(codes::PARTITION_NOT_PRIMARY, message)
        .with_detail("indexName", Value::from(scope.index_name.as_str()))
        .with_detail("partitionId", Value::from(scope.partition_id))
        .with_detail("localNodeId", Value::from(node_id))
        .with_detail("expectedPrimaryTerm", Value::from(scope.primary_term))
        .with_detail("currentPrimaryNodeId", primary)
        .with_detail("currentPrimaryTerm", primary_term)
}

fn authority_changed_message(scope: &Scope) -> String {
    format!(
        "Primary authority changed before acknowledging write for index '{}' partition {}",
        scope.index_name, scope.partition_id
    )
}

pub(super) fn authority_changed(
    scope: &Scope,
    node_id: &str,
    current: Option<&Assignment>,
) -> ClusterError {
    changed_authority(scope, node_id, current, authority_changed_message(scope))
}

pub(super) fn superseded_by(
    scope: &Scope,
    node_id: &str,
    primary_node_id: &str,
    primary_term: u64,
) -> ClusterError {
    authority_moved(
        scope,
        node_id,
        Value::from(primary_node_id),
        Value::from(primary_term),
        authority_changed_message(scope),
    )
}

pub(super) fn no_longer_leads_term(
    scope: &Scope,
    node_id: &str,
    current: Option<&Assignment>,
) -> ClusterError {
    let message = format!(
        "Node '{node_id}' no longer leads partition {} of index '{}' under term {}",
        scope.partition_id, scope.index_name, scope.primary_term
    );
    changed_authority(scope, node_id, current, message)
}

pub(super) fn outcome_unknown(
    scope: &Scope,
    original: &ClusterError,
    reason: &str,
    because: &str,
) -> ClusterError {
    ClusterError::new(
        codes::REPLICATION_OUTCOME_UNKNOWN,
        format!(
            "A write to partition {} of index '{}' failed after the primary applied it, and {because}, so the write may or may not have taken effect. Read the document before you retry the write.",
            scope.partition_id, scope.index_name
        ),
    )
    .with_detail("indexName", Value::from(scope.index_name.as_str()))
    .with_detail("partitionId", Value::from(scope.partition_id))
    .with_detail("primaryTerm", Value::from(scope.primary_term))
    .with_detail("reason", Value::from(reason))
    .with_detail("originalError", Value::from(original.message()))
}

pub(super) fn failed_copy_outcome(scope: &Scope, cause: &ClusterError) -> ClusterError {
    outcome_unknown(
        scope,
        cause,
        TERM_ENDED,
        "the primary's copy failed while its log may hold the write",
    )
}

pub(super) fn is_outcome_unknown(error: &ClusterError) -> bool {
    error.code() == codes::REPLICATION_OUTCOME_UNKNOWN
}

pub(super) fn abandoned_with_term(error: &ClusterError) -> bool {
    is_outcome_unknown(error) && error.details().get("reason") == Some(&Value::from(TERM_ENDED))
}

pub(super) fn lost_term(error: &ClusterError) -> bool {
    error.code() == codes::PARTITION_NOT_PRIMARY
}

pub(super) fn rollback_failed(
    kind: ForwardKind,
    scope: &Scope,
    document_id: &str,
    original: &ClusterError,
    rollback: &str,
) -> ClusterError {
    let operation = kind.wording();
    ClusterError::new(
        codes::REPLICATION_ROLLBACK_FAILED,
        format!(
            "Primary {operation} for document '{document_id}' in index '{}' failed before acknowledgement and local rollback also failed",
            scope.index_name
        ),
    )
    .with_detail("operation", Value::from(operation))
    .with_detail("indexName", Value::from(scope.index_name.as_str()))
    .with_detail("partitionId", Value::from(scope.partition_id))
    .with_detail("documentId", Value::from(document_id))
    .with_detail("originalError", Value::from(original.message()))
    .with_detail("rollbackError", Value::from(rollback))
}

pub(super) fn insync_removal_failed(
    scope: &Scope,
    message: String,
    replica_node_id: Option<&str>,
) -> ClusterError {
    let error = ClusterError::new(codes::REPLICATION_INSYNC_REMOVAL_FAILED, message)
        .with_detail("indexName", Value::from(scope.index_name.as_str()))
        .with_detail("partitionId", Value::from(scope.partition_id));
    match replica_node_id {
        Some(replica_node_id) => error.with_detail("replicaNodeId", Value::from(replica_node_id)),
        None => error,
    }
}
