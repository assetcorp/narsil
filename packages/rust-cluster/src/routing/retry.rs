use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::time::{Instant, timeout_at};

use super::WriteRouter;
use super::rules::{History, next_condition, retriable, retried_after_delay, window_ended_outcome};
use super::wait::{RefusingPrimary, next_retry_delay, primary_for};
use super::write::{Attempted, PendingWrite, Refused};
use crate::constants::FORWARD_RETRY_INITIAL_DELAY_MS;
use crate::error::{ClusterError, ClusterResult, codes};

pub(super) type Answered = (usize, Result<(), ClusterError>);

fn unanswered(serving_name: &str, document_id: &str) -> ClusterError {
    ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!(
            "The write to document '{document_id}' of index '{serving_name}' stopped before it answered"
        ),
    )
}

fn last_answer(
    serving_name: &str,
    write: &PendingWrite,
    histories: &HashMap<usize, History>,
    last_refusal: Option<ClusterError>,
) -> ClusterError {
    let document_id = write.document_id();
    match (last_refusal, histories.get(&write.position)) {
        (Some(error), Some(history)) => history.final_error(serving_name, document_id, error),
        (Some(error), None) => error,
        (None, _) => window_ended_outcome(serving_name, document_id),
    }
}

impl WriteRouter {
    async fn attempt_before_deadline(
        self: &Arc<Self>,
        serving_name: &Arc<str>,
        pending: &[PendingWrite],
        deadline: Instant,
        batch: bool,
    ) -> ClusterResult<Option<HashMap<usize, Attempted>>> {
        let attempt = tokio::spawn(Arc::clone(self).attempt(
            Arc::clone(serving_name),
            pending.to_vec(),
            batch,
            deadline,
        ));
        match timeout_at(deadline, attempt).await {
            Err(_) => Ok(None),
            Ok(Err(stopped)) => Err(ClusterError::new(
                codes::INTERNAL_ERROR,
                format!("A write to index '{serving_name}' stopped before it answered: {stopped}"),
            )),
            Ok(Ok(outcomes)) => Ok(Some(outcomes?.into_iter().collect())),
        }
    }

    async fn settle(
        &self,
        serving_name: &str,
        failures: &[(&PendingWrite, Box<Refused>)],
        histories: &HashMap<usize, History>,
        acknowledged: &HashSet<String>,
        deadline: Instant,
    ) -> HashSet<usize> {
        let uncertain: Vec<(&PendingWrite, &Refused)> = failures
            .iter()
            .filter(|(write, _)| {
                histories
                    .get(&write.position)
                    .is_some_and(|history| history.may_have_applied)
            })
            .map(|(write, refused)| (*write, &**refused))
            .collect();
        if uncertain.is_empty() {
            return HashSet::new();
        }
        let settling = self.settle_equal_inserts(serving_name, &uncertain, acknowledged);
        timeout_at(deadline, settling).await.unwrap_or_default()
    }

    pub(super) async fn retry_group(
        self: Arc<Self>,
        serving_name: Arc<str>,
        mut pending: Vec<PendingWrite>,
        deadline: Instant,
        settles_as_equal: bool,
        batch: bool,
    ) -> Vec<Answered> {
        let mut answered: Vec<Answered> = Vec::with_capacity(pending.len());
        let mut histories: HashMap<usize, History> = HashMap::new();
        let mut acknowledged: HashSet<String> = HashSet::new();
        let mut last_refusals: HashMap<usize, ClusterError> = HashMap::new();
        let mut delay = Duration::from_millis(FORWARD_RETRY_INITIAL_DELAY_MS);
        while !pending.is_empty() {
            let read = timeout_at(deadline, self.view.read(&serving_name)).await;
            let Some(read) = read.ok().filter(|_| Instant::now() < deadline) else {
                for write in &pending {
                    let error = last_answer(
                        &serving_name,
                        write,
                        &histories,
                        last_refusals.remove(&write.position),
                    );
                    answered.push((write.position, Err(error)));
                }
                break;
            };
            let table = read.ok().flatten();
            let attempted = self
                .attempt_before_deadline(&serving_name, &pending, deadline, batch)
                .await;
            let mut outcomes = match attempted {
                Ok(Some(outcomes)) => outcomes,
                Ok(None) => {
                    for write in &pending {
                        let ended = window_ended_outcome(&serving_name, write.document_id());
                        answered.push((write.position, Err(ended)));
                    }
                    break;
                }
                Err(error) => {
                    for write in &pending {
                        let refused =
                            last_answer(&serving_name, write, &histories, Some(error.clone()));
                        answered.push((write.position, Err(refused)));
                    }
                    break;
                }
            };
            let mut failures: Vec<(&PendingWrite, Box<Refused>)> = Vec::new();
            for write in &pending {
                match outcomes.remove(&write.position) {
                    Some(Ok(())) => {
                        acknowledged.insert(write.document_id().to_string());
                        answered.push((write.position, Ok(())));
                    }
                    Some(Err(refused)) => failures.push((write, refused)),
                    None => failures.push((
                        write,
                        Refused::of(unanswered(&serving_name, write.document_id())),
                    )),
                }
            }
            let settled = if settles_as_equal {
                self.settle(
                    &serving_name,
                    &failures,
                    &histories,
                    &acknowledged,
                    deadline,
                )
                .await
            } else {
                HashSet::new()
            };
            let mut refused_writes: Vec<(PendingWrite, Box<Refused>, RefusingPrimary)> = Vec::new();
            for (write, refused) in failures {
                let (position, document_id) = (write.position, write.document_id());
                if settled.contains(&position) {
                    acknowledged.insert(document_id.to_string());
                    answered.push((position, Ok(())));
                    continue;
                }
                let history = histories.entry(position).or_default();
                if !refused.withheld {
                    history.record(&refused.error);
                }
                match primary_for(table.as_ref(), document_id) {
                    Some(refusing) if retriable(&refused, settles_as_equal) => {
                        refused_writes.push((write.clone(), refused, refusing));
                    }
                    _ => {
                        let error = history.final_error(&serving_name, document_id, refused.error);
                        answered.push((position, Err(error)));
                    }
                }
            }
            if refused_writes.is_empty() {
                break;
            }
            let retryable = if refused_writes
                .iter()
                .any(|(_, refused, _)| retried_after_delay(&refused.error))
            {
                let retryable = self.pause_and_reread(&serving_name, delay, deadline).await;
                delay = next_retry_delay(delay);
                retryable
            } else {
                let refusing: Vec<RefusingPrimary> = refused_writes
                    .iter()
                    .map(|(_, _, refusing)| refusing.clone())
                    .collect();
                self.await_new_primary(&serving_name, &refusing, deadline)
                    .await
            };
            if !retryable {
                for (write, refused, _) in refused_writes {
                    let history = histories.entry(write.position).or_default();
                    let error =
                        history.final_error(&serving_name, write.document_id(), refused.error);
                    answered.push((write.position, Err(error)));
                }
                break;
            }
            pending = refused_writes
                .into_iter()
                .map(|(mut write, refused, _)| {
                    last_refusals.insert(write.position, refused.error.clone());
                    if !refused.withheld {
                        write.condition = next_condition(&refused, write.condition);
                    }
                    write
                })
                .collect();
        }
        answered
    }
}
