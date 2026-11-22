use std::sync::Arc;
use std::time::Instant;

use narsil::ErrorCode;
use narsil::replication::{PrimaryRefusal, PrimaryWrite, ReplicatedEntry, WriteRecord};

use super::PrimaryWrites;
use super::errors::{abandoned_with_term, failed_copy_outcome, rollback_failed};
use super::log::chunked;
use super::partition::QueueTurn;
use super::run::{AppliedWrite, RunState, decoded_document, refusal_of};
use super::scope::Scope;
use crate::error::ClusterError;
use crate::payload::forward::{AbandonedWrite, ForwardKind, WriteFailure};

const NO_SNAPSHOT: &str = "No local document snapshot was available for restore";

struct Compensating {
    position: usize,
    failed: ReplicatedEntry,
    previous: Option<WriteRecord>,
    compensation: Option<ReplicatedEntry>,
}

fn compensation_of(kind: ForwardKind, applied: &AppliedWrite) -> Result<PrimaryWrite, String> {
    let document_id = applied.document_id.clone();
    if kind == ForwardKind::Insert {
        return Ok(PrimaryWrite::Remove { document_id });
    }
    let Some(prior) = &applied.prior else {
        return Err(NO_SNAPSHOT.to_string());
    };
    let document = decoded_document(&prior.document, &applied.document_id)
        .map_err(|error| error.message().to_string())?;
    Ok(match kind {
        ForwardKind::Remove => PrimaryWrite::Insert {
            document_id,
            document,
        },
        _ => PrimaryWrite::Update {
            document_id,
            document,
        },
    })
}

fn marked(answer: &ClusterError, item: &Compensating) -> WriteFailure {
    let abandoned = match (&item.compensation, item.previous) {
        (Some(compensation), Some(previous)) if abandoned_with_term(answer) => {
            Some(AbandonedWrite {
                seq_no: item.failed.seq_no,
                primary_term: item.failed.primary_term,
                compensation_seq_no: compensation.seq_no,
                previous_seq_no: previous.seq_no,
                previous_primary_term: previous.primary_term,
            })
        }
        _ => None,
    };
    WriteFailure {
        error: answer.clone(),
        abandoned,
    }
}

impl PrimaryWrites {
    async fn compensate(
        self: &Arc<Self>,
        scope: &Scope,
        state: &mut RunState<'_>,
        abandoned: Vec<(AppliedWrite, ReplicatedEntry)>,
        original: &ClusterError,
    ) -> Vec<Compensating> {
        let mut writes = Vec::new();
        let mut items = Vec::new();
        let mut unrestored = None;
        for (applied, failed) in abandoned.into_iter().rev() {
            match compensation_of(state.kind, &applied) {
                Ok(write) => {
                    writes.push(write);
                    items.push(Compensating {
                        position: applied.position,
                        failed,
                        previous: applied.prior.and_then(|prior| prior.record),
                        compensation: None,
                    });
                }
                Err(text) => {
                    let error =
                        rollback_failed(state.kind, scope, &applied.document_id, original, &text);
                    state.fail(applied.position, failed_copy_outcome(scope, &error));
                    unrestored.get_or_insert(error);
                }
            }
        }
        if writes.is_empty() {
            self.take_unrestored_copy_out_of_service(scope, state, unrestored);
            return items;
        }
        let run = match self.engine_write(scope, writes, state.limits).await {
            Ok(run) => run,
            Err(error) => {
                for item in items {
                    let error = rollback_failed(
                        state.kind,
                        scope,
                        &item.failed.document_id,
                        original,
                        error.message(),
                    );
                    state.fail(item.position, failed_copy_outcome(scope, &error));
                    unrestored.get_or_insert(error);
                }
                self.take_unrestored_copy_out_of_service(scope, state, unrestored);
                return Vec::new();
            }
        };
        let mut kept = Vec::with_capacity(items.len());
        let mut appended = Vec::new();
        for (mut item, outcome) in items.into_iter().zip(run.outcomes) {
            match outcome {
                Ok(written) => {
                    appended.push(written.entry.clone());
                    item.compensation = Some(written.entry);
                    kept.push(item);
                }
                Err(PrimaryRefusal::Refused(error))
                    if state.kind == ForwardKind::Insert
                        && error.code() == ErrorCode::DOC_NOT_FOUND
                        && run.failure.as_ref() != Some(&error) =>
                {
                    kept.push(item);
                }
                Err(PrimaryRefusal::Refused(error)) if run.failure.as_ref() == Some(&error) => {
                    state.fail(item.position, failed_copy_outcome(scope, &error.into()));
                }
                Err(refusal) => {
                    let text = refusal_of(scope, refusal, &state.limits)
                        .message()
                        .to_string();
                    let error = rollback_failed(
                        state.kind,
                        scope,
                        &item.failed.document_id,
                        original,
                        &text,
                    );
                    state.fail(item.position, failed_copy_outcome(scope, &error));
                    unrestored.get_or_insert(error);
                }
            }
        }
        self.note_appended(scope, &appended);
        if let Some(failure) = run.failure {
            self.note_copy_failure(scope, state, failure.into());
        }
        self.take_unrestored_copy_out_of_service(scope, state, unrestored);
        kept
    }

    fn take_unrestored_copy_out_of_service(
        self: &Arc<Self>,
        scope: &Scope,
        state: &mut RunState<'_>,
        unrestored: Option<ClusterError>,
    ) {
        if let Some(cause) = unrestored {
            self.note_copy_failure(scope, state, cause);
        }
    }

    pub(super) async fn replicate_applied(
        self: &Arc<Self>,
        scope: &Scope,
        turn: &mut QueueTurn,
        state: &mut RunState<'_>,
    ) {
        let entries = std::mem::take(&mut state.entries);
        let applied = std::mem::take(&mut state.applied);
        let mut replicated = 0;
        let mut abort = None;
        for chunk in chunked(&scope.index_name, &entries) {
            match self.replicate(scope, &scope.assignment, chunk).await {
                Ok(()) => replicated += chunk.len(),
                Err(error) => {
                    abort = Some(error);
                    break;
                }
            }
        }
        let Some(original) = abort else {
            state
                .outcomes
                .extend(applied.iter().map(|write| (write.position, Ok(()))));
            return;
        };
        let failed_at = Instant::now();
        let mut applied = applied.into_iter();
        for write in applied.by_ref().take(replicated) {
            state.outcomes.push((write.position, Ok(())));
        }
        let from_seq_no = entries[replicated].seq_no;
        let abandoned: Vec<(AppliedWrite, ReplicatedEntry)> =
            applied.zip(entries.into_iter().skip(replicated)).collect();
        let compensated = self.compensate(scope, state, abandoned, &original).await;
        if let Some(cause) = state.copy_failure.take() {
            let answer = failed_copy_outcome(scope, &cause);
            for item in &compensated {
                state
                    .outcomes
                    .push((item.position, Err(marked(&answer, item))));
            }
            return;
        }
        let answer = self
            .settle_rollback(scope, turn, from_seq_no, &original, failed_at)
            .await;
        for item in &compensated {
            state
                .outcomes
                .push((item.position, Err(marked(&answer, item))));
        }
    }
}
