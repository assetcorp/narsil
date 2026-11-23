use std::collections::HashMap;
use std::sync::Arc;

use narsil::{Map, Value};
use tokio::task::JoinSet;

use super::selection::PartitionRouting;
use crate::error::{ClusterError, codes};
use crate::transport::BoxFuture;

const QUERY_REJECTION_CODES: [&str; 11] = [
    codes::SEARCH_INVALID_FIELD,
    codes::SEARCH_INVALID_FILTER,
    codes::SEARCH_INVALID_MODE,
    codes::SEARCH_INVALID_CURSOR,
    codes::SEARCH_RESULT_WINDOW_EXCEEDED,
    codes::SEARCH_WORK_CAP_EXCEEDED,
    codes::SEARCH_INVALID_PHRASE,
    codes::SEARCH_PHRASE_NOT_READY,
    codes::BM25_NOT_READY,
    codes::VECTOR_DIMENSION_MISMATCH,
    codes::CONFIG_INVALID,
];

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Failure {
    pub(crate) error: ClusterError,
    pub(crate) node_rejection: bool,
}

impl Failure {
    pub(crate) fn of(error: ClusterError) -> Failure {
        Failure {
            error,
            node_rejection: false,
        }
    }
}

impl From<ClusterError> for Failure {
    fn from(error: ClusterError) -> Failure {
        Failure::of(error)
    }
}

fn number_detail(details: &Map, key: &str) -> Option<f64> {
    match details.get(key) {
        Some(Value::Number(number)) => Some(*number),
        _ => None,
    }
}

fn refused_for_newer_generation(details: &Map) -> bool {
    match (
        number_detail(details, "heldGeneration"),
        number_detail(details, "requestedGeneration"),
    ) {
        (Some(held), Some(requested)) => held > requested,
        _ => false,
    }
}

fn error_with(code: &str, message: &str, details: &Map) -> ClusterError {
    let mut error = ClusterError::new(code, message);
    for (key, value) in details.iter() {
        error = error.with_detail(key, value.clone());
    }
    error
}

pub(crate) fn generation_refusal_of(
    code: Option<&str>,
    message: Option<&str>,
    details: &Map,
) -> Option<Failure> {
    let code = code.filter(|code| *code == codes::ANALYSIS_GENERATION_MISSING)?;
    Some(Failure {
        error: error_with(code, message.unwrap_or(code), details),
        node_rejection: refused_for_newer_generation(details),
    })
}

pub(crate) fn node_rejection_of(
    code: Option<&str>,
    message: Option<&str>,
    details: &Map,
) -> Option<Failure> {
    if let Some(refusal) = generation_refusal_of(code, message, details) {
        return Some(refusal);
    }
    let code = code.filter(|code| QUERY_REJECTION_CODES.contains(code))?;
    Some(Failure {
        error: error_with(code, message.unwrap_or(code), details),
        node_rejection: true,
    })
}

pub(crate) fn is_timeout_failure(error: &ClusterError) -> bool {
    error.code() == codes::TRANSPORT_TIMEOUT || error.code() == codes::QUERY_NODE_TIMEOUT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutcomeStatus {
    Success,
    Timeout,
    Failed,
}

pub(crate) struct FailoverOutcome<T> {
    pub(crate) node_id: String,
    pub(crate) partition_ids: Vec<u32>,
    pub(crate) status: OutcomeStatus,
    pub(crate) result: Option<T>,
    pub(crate) error: Option<Failure>,
}

pub(crate) type Attempt<T> =
    Arc<dyn Fn(String, Vec<u32>) -> BoxFuture<'static, Result<Option<T>, Failure>> + Send + Sync>;

struct CopyOrder {
    copies_by_partition: HashMap<u32, Vec<String>>,
}

fn group_by_next_copy(
    order: &CopyOrder,
    failed_node_id: &str,
    partition_ids: &[u32],
) -> (Vec<(String, Vec<u32>)>, Vec<u32>) {
    let mut retries: Vec<(String, Vec<u32>)> = Vec::new();
    let mut exhausted = Vec::new();
    for partition_id in partition_ids {
        let copies = order
            .copies_by_partition
            .get(partition_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let next_copy = copies
            .iter()
            .position(|copy| copy == failed_node_id)
            .and_then(|position| copies.get(position + 1));
        let Some(next_copy) = next_copy else {
            exhausted.push(*partition_id);
            continue;
        };
        match retries.iter_mut().find(|(node_id, _)| node_id == next_copy) {
            Some((_, group)) => group.push(*partition_id),
            None => retries.push((next_copy.clone(), vec![*partition_id])),
        }
    }
    (retries, exhausted)
}

fn stopped_outcome<T>(node_id: String, partition_ids: Vec<u32>) -> FailoverOutcome<T> {
    FailoverOutcome {
        node_id,
        partition_ids,
        status: OutcomeStatus::Failed,
        result: None,
        error: Some(Failure::of(ClusterError::new(
            codes::INTERNAL_ERROR,
            "A read of a partition stopped before it finished",
        ))),
    }
}

async fn in_order<T: Send + 'static>(
    tries: Vec<(String, Vec<u32>)>,
    order: &Arc<CopyOrder>,
    attempt: &Attempt<T>,
) -> Vec<FailoverOutcome<T>> {
    let mut running = JoinSet::new();
    let mut slots: Vec<Option<Vec<FailoverOutcome<T>>>> = Vec::with_capacity(tries.len());
    let mut started = Vec::with_capacity(tries.len());
    for (position, (node_id, partition_ids)) in tries.into_iter().enumerate() {
        slots.push(None);
        started.push((node_id.clone(), partition_ids.clone()));
        let order = Arc::clone(order);
        let attempt = Arc::clone(attempt);
        running.spawn(async move {
            (
                position,
                try_copy(node_id, partition_ids, order, attempt).await,
            )
        });
    }
    while let Some(joined) = running.join_next().await {
        if let Ok((position, outcomes)) = joined
            && let Some(slot) = slots.get_mut(position)
        {
            *slot = Some(outcomes);
        }
    }
    slots
        .into_iter()
        .zip(started)
        .flat_map(|(slot, (node_id, partition_ids))| {
            slot.unwrap_or_else(|| vec![stopped_outcome(node_id, partition_ids)])
        })
        .collect()
}

fn try_copy<T: Send + 'static>(
    node_id: String,
    partition_ids: Vec<u32>,
    order: Arc<CopyOrder>,
    attempt: Attempt<T>,
) -> BoxFuture<'static, Vec<FailoverOutcome<T>>> {
    Box::pin(async move {
        let failure = match attempt(node_id.clone(), partition_ids.clone()).await {
            Ok(Some(result)) => {
                return vec![FailoverOutcome {
                    node_id,
                    partition_ids,
                    status: OutcomeStatus::Success,
                    result: Some(result),
                    error: None,
                }];
            }
            Ok(None) => FailoverOutcome {
                node_id: node_id.clone(),
                partition_ids: partition_ids.clone(),
                status: OutcomeStatus::Timeout,
                result: None,
                error: None,
            },
            Err(error) => {
                let status = if is_timeout_failure(&error.error) {
                    OutcomeStatus::Timeout
                } else {
                    OutcomeStatus::Failed
                };
                let rejected = error.node_rejection;
                let outcome = FailoverOutcome {
                    node_id: node_id.clone(),
                    partition_ids: partition_ids.clone(),
                    status,
                    result: None,
                    error: Some(error),
                };
                if rejected {
                    return vec![outcome];
                }
                outcome
            }
        };
        let (retries, exhausted) = group_by_next_copy(&order, &node_id, &partition_ids);
        let mut outcomes = in_order(retries, &order, &attempt).await;
        if !exhausted.is_empty() {
            outcomes.push(FailoverOutcome {
                partition_ids: exhausted,
                ..failure
            });
        }
        outcomes
    })
}

pub(crate) async fn send_with_failover<T: Send + 'static>(
    routing: &PartitionRouting,
    attempt: Attempt<T>,
) -> Vec<FailoverOutcome<T>> {
    let order = Arc::new(CopyOrder {
        copies_by_partition: routing.copies_by_partition.clone(),
    });
    in_order(routing.node_to_partitions.clone(), &order, &attempt).await
}

pub(crate) async fn send_to_every_partition<T: Send + 'static>(
    routing: &PartitionRouting,
    attempt: Attempt<T>,
) -> Result<Vec<T>, Failure> {
    let outcomes = send_with_failover(routing, attempt).await;
    let mut answered = Vec::with_capacity(outcomes.len());
    for outcome in outcomes {
        match (outcome.status, outcome.result) {
            (OutcomeStatus::Success, Some(result)) => answered.push(result),
            _ => {
                return Err(outcome.error.unwrap_or_else(|| {
                    Failure::of(
                        ClusterError::new(
                            codes::QUERY_NODE_TIMEOUT,
                            format!("Node '{}' did not answer a read in time", outcome.node_id),
                        )
                        .with_detail("nodeId", Value::from(outcome.node_id.as_str())),
                    )
                }));
            }
        }
    }
    Ok(answered)
}
