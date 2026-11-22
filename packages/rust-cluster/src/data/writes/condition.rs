use std::collections::HashMap;

use narsil::Value;
use narsil::replication::{HeldTerm, WriteRecord};

use super::PrimaryWrites;
use super::errors::TERM_ENDED;
use super::scope::Scope;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::forward::WriteCondition;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Apply,
    Acknowledge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AppliedResend {
    pub(super) abandoned: WriteRecord,
    pub(super) appended: WriteRecord,
}

pub(super) type Resends = HashMap<String, AppliedResend>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Coverage {
    Matched,
    Absent,
    Uncovered,
}

fn held_as(term: HeldTerm, primary_term: u64) -> Coverage {
    match term {
        HeldTerm::Absent => Coverage::Absent,
        HeldTerm::Uncovered => Coverage::Uncovered,
        HeldTerm::Held(held) if held == primary_term => Coverage::Matched,
        HeldTerm::Held(_) => Coverage::Absent,
    }
}

struct Evidence {
    failed: Coverage,
    compensation: Coverage,
    record: Option<WriteRecord>,
}

fn outcome_unknown_after_retry(scope: &Scope, document_id: &str, because: &str) -> ClusterError {
    ClusterError::new(
        codes::REPLICATION_OUTCOME_UNKNOWN,
        format!(
            "A write to document '{document_id}' in partition {} of index '{}' was sent again after the earlier primary's term ended, and {because}, so the earlier attempt may or may not have taken effect. Read the document before you retry the write.",
            scope.partition_id, scope.index_name
        ),
    )
    .with_detail("indexName", Value::from(scope.index_name.as_str()))
    .with_detail("partitionId", Value::from(scope.partition_id))
    .with_detail("primaryTerm", Value::from(scope.primary_term))
    .with_detail("reason", Value::from(TERM_ENDED))
}

fn write_conflict(scope: &Scope, document_id: &str) -> ClusterError {
    ClusterError::new(
        codes::REPLICATION_WRITE_CONFLICT,
        format!(
            "Another write touched document '{document_id}' in index '{}' after the earlier primary's attempt, so this primary refused the write that was sent again. The write did not take effect.",
            scope.index_name
        ),
    )
    .with_detail("indexName", Value::from(scope.index_name.as_str()))
    .with_detail("partitionId", Value::from(scope.partition_id))
    .with_detail("documentId", Value::from(document_id))
}

fn decide(
    scope: &Scope,
    document_id: &str,
    condition: &WriteCondition,
    evidence: &Evidence,
    earlier: Option<&AppliedResend>,
) -> ClusterResult<Verdict> {
    let lost_record = "this copy no longer records the term of the earlier attempt";
    if evidence.failed == Coverage::Uncovered {
        return Err(outcome_unknown_after_retry(scope, document_id, lost_record));
    }
    let failed_held = evidence.failed == Coverage::Matched;
    if failed_held {
        match evidence.compensation {
            Coverage::Uncovered => {
                return Err(outcome_unknown_after_retry(scope, document_id, lost_record));
            }
            Coverage::Absent => return Ok(Verdict::Acknowledge),
            Coverage::Matched => {}
        }
    }
    let Some(record) = evidence.record else {
        return Err(outcome_unknown_after_retry(
            scope,
            document_id,
            "this copy holds no write record for the document",
        ));
    };
    let expected = if failed_held {
        WriteRecord {
            seq_no: condition.compensation_seq_no,
            primary_term: condition.abandoned_primary_term,
        }
    } else {
        WriteRecord {
            seq_no: condition.if_seq_no,
            primary_term: condition.if_primary_term,
        }
    };
    if record == expected {
        return Ok(Verdict::Apply);
    }
    let chained = earlier.is_some_and(|earlier| {
        earlier.abandoned.seq_no == condition.if_seq_no
            && earlier.abandoned.primary_term == condition.if_primary_term
            && earlier.appended == record
    });
    if chained {
        return Ok(Verdict::Apply);
    }
    Err(write_conflict(scope, document_id))
}

impl PrimaryWrites {
    pub(super) async fn decide_condition(
        &self,
        scope: &Scope,
        document_id: &str,
        condition: &WriteCondition,
        resends: &Resends,
    ) -> ClusterResult<Verdict> {
        let (name, partition_id, id) = (
            scope.index_name.clone(),
            scope.partition_id,
            document_id.to_string(),
        );
        let held = *condition;
        let evidence = self
            .on_copies(move |copies| {
                let term = held.abandoned_primary_term;
                let failed = held_as(
                    copies.held_term(&name, partition_id, held.abandoned_seq_no)?,
                    term,
                );
                let compensation = if failed == Coverage::Matched {
                    held_as(
                        copies.held_term(&name, partition_id, held.compensation_seq_no)?,
                        term,
                    )
                } else {
                    Coverage::Absent
                };
                let record = copies.write_record(&name, partition_id, &id)?;
                Ok(Evidence {
                    failed,
                    compensation,
                    record,
                })
            })
            .await?;
        decide(
            scope,
            document_id,
            condition,
            &evidence,
            resends.get(document_id),
        )
    }
}
