use std::sync::Arc;

use narsil::replication::{
    PrimaryLimits, PrimaryRefusal, PrimaryWrite, PriorDocument, ReplicatedEntry, WriteRecord,
};
use narsil::{ErrorCode, Map, Value, decode_msgpack};

use super::PrimaryWrites;
use super::condition::{AppliedResend, Resends, Verdict};
use super::errors::{failed_copy_outcome, no_longer_leads};
use super::partition::QueueTurn;
use super::scope::{Outcome, Scope};
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::forward::{ForwardKind, ForwardOperation, WriteFailure};

pub(super) struct Planned {
    pub(super) position: usize,
    pub(super) operation: ForwardOperation,
}

struct Pending {
    position: usize,
    document_id: String,
    resend: Option<WriteRecord>,
}

pub(super) struct AppliedWrite {
    pub(super) position: usize,
    pub(super) document_id: String,
    pub(super) prior: Option<PriorDocument>,
}

pub(super) struct RunState<'r> {
    pub(super) kind: ForwardKind,
    pub(super) limits: PrimaryLimits,
    pub(super) outcomes: Vec<(usize, Outcome)>,
    pending: Vec<Pending>,
    pending_writes: Vec<PrimaryWrite>,
    pub(super) applied: Vec<AppliedWrite>,
    pub(super) entries: Vec<ReplicatedEntry>,
    pub(super) copy_failure: Option<ClusterError>,
    resends: &'r mut Resends,
}

impl RunState<'_> {
    pub(super) fn fail(&mut self, position: usize, error: ClusterError) {
        self.outcomes
            .push((position, Err(WriteFailure::from(error))));
    }
}

pub(super) fn decoded_document(bytes: &[u8], document_id: &str) -> ClusterResult<Map> {
    let invalid = |message: String| {
        ClusterError::new(ErrorCode::DOC_VALIDATION_FAILED.as_str(), message)
            .with_detail("documentId", Value::from(document_id))
    };
    match decode_msgpack(bytes) {
        Ok(Value::Object(document)) => Ok(document),
        Ok(_) => Err(invalid(
            "A forwarded document must be a MessagePack map".to_string(),
        )),
        Err(error) => Err(invalid(format!(
            "Forwarded document could not be decoded: {}",
            error.message()
        ))),
    }
}

fn log_full(scope: &Scope, bytes: u64, retention_bytes: u64) -> ClusterError {
    ClusterError::new(
        codes::REPLICATION_LOG_FULL,
        format!(
            "Replication log entry of {bytes} bytes exceeds the log retention limit of {retention_bytes} bytes and cannot be buffered"
        ),
    )
    .with_detail("partitionId", Value::from(scope.partition_id))
    .with_detail("entrySize", Value::from(bytes))
    .with_detail("retentionBytes", Value::from(retention_bytes))
}

pub(super) fn refusal_of(
    scope: &Scope,
    refusal: PrimaryRefusal,
    limits: &PrimaryLimits,
) -> ClusterError {
    match refusal {
        PrimaryRefusal::Refused(error) => error.into(),
        PrimaryRefusal::EntryTooLarge { bytes } => log_full(scope, bytes, limits.max_entry_bytes),
    }
}

impl PrimaryWrites {
    pub(super) async fn engine_write(
        &self,
        scope: &Scope,
        writes: Vec<PrimaryWrite>,
        limits: PrimaryLimits,
    ) -> ClusterResult<narsil::replication::PrimaryRun> {
        let (name, partition_id, term) = (
            scope.index_name.clone(),
            scope.partition_id,
            scope.primary_term,
        );
        self.on_copies(move |copies| {
            copies.primary_write(&name, partition_id, term, writes, limits)
        })
        .await
    }

    pub(super) fn note_appended(&self, scope: &Scope, entries: &[ReplicatedEntry]) {
        let partition = self.partitions.of(&scope.index_name, scope.partition_id);
        lock(&partition.log).append(&scope.index_name, entries, self.log_retention_bytes);
    }

    pub(super) fn note_copy_failure(
        self: &Arc<Self>,
        scope: &Scope,
        state: &mut RunState<'_>,
        cause: ClusterError,
    ) {
        state.copy_failure.get_or_insert(cause);
        self.record_copy_failure(&scope.index_name, scope.partition_id);
    }

    async fn flush(self: &Arc<Self>, scope: &Scope, state: &mut RunState<'_>) {
        if state.pending.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut state.pending);
        let writes = std::mem::take(&mut state.pending_writes);
        let run = match self.engine_write(scope, writes, state.limits).await {
            Ok(run) => run,
            Err(error) => {
                for held in pending {
                    state.fail(held.position, error.clone());
                }
                return;
            }
        };
        let from = state.entries.len();
        for (held, outcome) in pending.into_iter().zip(run.outcomes) {
            match outcome {
                Ok(written) => {
                    let appended = WriteRecord {
                        seq_no: written.entry.seq_no,
                        primary_term: written.entry.primary_term,
                    };
                    if let Some(abandoned) = held.resend {
                        state.resends.insert(
                            held.document_id.clone(),
                            AppliedResend {
                                abandoned,
                                appended,
                            },
                        );
                    }
                    state.entries.push(written.entry);
                    state.applied.push(AppliedWrite {
                        position: held.position,
                        document_id: held.document_id,
                        prior: written.prior,
                    });
                }
                Err(PrimaryRefusal::Refused(error)) if run.failure.as_ref() == Some(&error) => {
                    state.fail(held.position, failed_copy_outcome(scope, &error.into()));
                }
                Err(refusal) => {
                    let error = refusal_of(scope, refusal, &state.limits);
                    state.fail(held.position, error);
                }
            }
        }
        self.note_appended(scope, &state.entries[from..]);
        if let Some(failure) = run.failure {
            self.note_copy_failure(scope, state, failure.into());
        }
    }

    async fn replacement(
        &self,
        scope: &Scope,
        document_id: &str,
        document: Option<Vec<u8>>,
        update_fields: Option<Map>,
    ) -> ClusterResult<Map> {
        if let Some(document) = document {
            return decoded_document(&document, document_id);
        }
        let Some(fields) = update_fields else {
            return Err(crate::payload::invalid_entry(
                "ForwardPayload",
                "update requires a document or updateFields",
            ));
        };
        let (name, id) = (scope.index_name.clone(), document_id.to_string());
        let Some(mut existing) = self
            .on_copies(move |copies| copies.whole_document(&name, &id))
            .await?
        else {
            return Err(ClusterError::new(
                ErrorCode::DOC_NOT_FOUND.as_str(),
                format!(
                    "Document '{document_id}' does not exist in index '{}'",
                    scope.index_name
                ),
            )
            .with_detail("indexName", Value::from(scope.index_name.as_str()))
            .with_detail("documentId", Value::from(document_id)));
        };
        for (field, value) in fields.iter() {
            existing.insert(field.clone(), value.clone());
        }
        Ok(existing)
    }

    async fn plan(self: &Arc<Self>, scope: &Scope, state: &mut RunState<'_>, planned: Planned) {
        let position = planned.position;
        let ForwardOperation {
            document_id,
            document,
            update_fields,
            condition,
            ..
        } = planned.operation;
        let condition = match condition {
            Ok(condition) => condition,
            Err(error) => return state.fail(position, error),
        };
        if state
            .pending
            .iter()
            .any(|held| held.document_id == document_id)
        {
            self.flush(scope, state).await;
        }
        if state.copy_failure.is_some() {
            return state.fail(position, no_longer_leads(scope, &self.node_id));
        }
        let resend = match condition {
            None => None,
            Some(condition) => {
                match self
                    .decide_condition(scope, &document_id, &condition, state.resends)
                    .await
                {
                    Ok(Verdict::Acknowledge) => return state.outcomes.push((position, Ok(()))),
                    Ok(Verdict::Apply) => Some(WriteRecord {
                        seq_no: condition.abandoned_seq_no,
                        primary_term: condition.abandoned_primary_term,
                    }),
                    Err(error) => return state.fail(position, error),
                }
            }
        };
        let write = match state.kind {
            ForwardKind::Remove => PrimaryWrite::Remove {
                document_id: document_id.clone(),
            },
            ForwardKind::Insert => {
                let decoded = document
                    .ok_or_else(|| {
                        crate::payload::invalid_entry(
                            "ForwardPayload",
                            "insert requires a document",
                        )
                    })
                    .and_then(|bytes| decoded_document(&bytes, &document_id));
                match decoded {
                    Ok(document) => PrimaryWrite::Insert {
                        document_id: document_id.clone(),
                        document,
                    },
                    Err(error) => return state.fail(position, error),
                }
            }
            ForwardKind::Update => {
                match self
                    .replacement(scope, &document_id, document, update_fields)
                    .await
                {
                    Ok(document) => PrimaryWrite::Update {
                        document_id: document_id.clone(),
                        document,
                    },
                    Err(error) => return state.fail(position, error),
                }
            }
        };
        state.pending.push(Pending {
            position,
            document_id,
            resend,
        });
        state.pending_writes.push(write);
    }

    pub(super) async fn apply_run(
        self: &Arc<Self>,
        scope: Scope,
        mut turn: QueueTurn,
        kind: ForwardKind,
        operations: Vec<Planned>,
        resends: &mut Resends,
    ) -> Vec<(usize, Outcome)> {
        let limits = PrimaryLimits {
            records_previous_documents: self
                .view
                .records_previous_documents(&scope.index_name)
                .await,
            max_entry_bytes: self.log_retention_bytes,
        };
        let mut state = RunState {
            kind,
            limits,
            outcomes: Vec::with_capacity(operations.len()),
            pending: Vec::new(),
            pending_writes: Vec::new(),
            applied: Vec::new(),
            entries: Vec::new(),
            copy_failure: None,
            resends,
        };
        for planned in operations {
            self.plan(&scope, &mut state, planned).await;
        }
        self.flush(&scope, &mut state).await;
        if let Some(cause) = state.copy_failure.take() {
            for applied in std::mem::take(&mut state.applied) {
                state.fail(applied.position, failed_copy_outcome(&scope, &cause));
            }
            return state.outcomes;
        }
        self.replicate_applied(&scope, &mut turn, &mut state).await;
        state.outcomes
    }
}
