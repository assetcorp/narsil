use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use narsil::{Map, QueryCoverage, Value};
use tokio::sync::oneshot;

use super::failover::{
    Attempt, Failure, OutcomeStatus, generation_refusal_of, node_rejection_of, send_with_failover,
};
use super::search_answer::{SearchAnswer, validate_search_result_payload};
use super::search_contexts::{RankingContext, release_search_contexts};
use super::selection::PartitionRouting;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::reads::ReadDeps;
use crate::reads::node_messaging::{
    SendFailureContext, answer_is_refusal, decoded_answer, remote_error_details, request,
    send_to_node,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DistributedQueryConfig {
    pub(crate) allow_partial_results: bool,
    pub(crate) partition_timeout_ms: u64,
    pub(crate) default_facet_size: usize,
    pub(crate) search_contexts: bool,
}

pub(crate) struct NodeQueryOutcome {
    pub(crate) node_id: String,
    pub(crate) partition_ids: Vec<u32>,
    pub(crate) status: OutcomeStatus,
    pub(crate) results: Option<SearchAnswer>,
}

fn query_rejection_of(answer: &TransportMessage, decoded: &Map) -> Option<Failure> {
    if !answer_is_refusal(answer, decoded) {
        return None;
    }
    let details = remote_error_details(decoded.get("details"));
    let code = decoded.get("code").and_then(Value::as_str);
    let message = decoded.get("message").and_then(Value::as_str);
    if let Some(refusal) = generation_refusal_of(code, message, &details) {
        return Some(refusal);
    }
    if code != Some(codes::TOO_MANY_REQUESTS) {
        return node_rejection_of(code, message, &Map::new());
    }
    let mut error = ClusterError::new(
        codes::TOO_MANY_REQUESTS,
        message.unwrap_or("A node had no room in memory to answer its part of the search"),
    );
    for (key, value) in details.iter() {
        error = error.with_detail(key, value.clone());
    }
    Some(Failure::of(error))
}

fn is_memory_refusal(failure: &Failure) -> bool {
    failure.error.code() == codes::TOO_MANY_REQUESTS
}

async fn send_and_validate<T>(
    deps: &ReadDeps,
    node_id: &str,
    message: &TransportMessage,
    validate: fn(Map) -> ClusterResult<T>,
) -> Result<T, Failure> {
    let failure = SendFailureContext {
        message: format!("Node '{node_id}' did not answer its part of a search"),
        index_name: None,
    };
    let answer = send_to_node(deps, node_id, message, &failure).await?;
    let decoded = decoded_answer(&answer)?;
    if let Some(rejection) = query_rejection_of(&answer, &decoded) {
        return Err(rejection);
    }
    Ok(validate(decoded)?)
}

pub(crate) type LateAnswer<T> = Box<dyn FnOnce(T) + Send>;

pub(crate) async fn send_with_timeout<T: Send + 'static>(
    deps: &Arc<ReadDeps>,
    node_id: String,
    message: TransportMessage,
    timeout_ms: u64,
    validate: fn(Map) -> ClusterResult<T>,
    on_late: Option<LateAnswer<T>>,
) -> Result<Option<T>, Failure> {
    let (answered, answer) = oneshot::channel();
    let sending = Arc::clone(deps);
    tokio::spawn(async move {
        let outcome = send_and_validate(&sending, &node_id, &message, validate).await;
        if let Err(Ok(late)) = answered.send(outcome)
            && let Some(on_late) = on_late
        {
            on_late(late);
        }
    });
    match tokio::time::timeout(Duration::from_millis(timeout_ms), answer).await {
        Ok(Ok(outcome)) => outcome.map(Some),
        Ok(Err(_)) => Err(Failure::of(ClusterError::new(
            codes::INTERNAL_ERROR,
            "A search request stopped before it finished",
        ))),
        Err(_) => Ok(None),
    }
}

pub(crate) fn partition_list(partition_ids: &[u32]) -> Value {
    Value::Array(partition_ids.iter().map(|id| Value::from(*id)).collect())
}

pub(crate) fn text_list<'a>(items: impl IntoIterator<Item = &'a String>) -> Value {
    Value::Array(
        items
            .into_iter()
            .map(|item| Value::from(item.as_str()))
            .collect(),
    )
}

pub(crate) struct SearchFanOut<'a> {
    pub(crate) index_name: &'a str,
    pub(crate) params: Value,
    pub(crate) global_stats: Option<Value>,
    pub(crate) facet_shard_size: Option<usize>,
    pub(crate) keep_alive_ms: Option<u64>,
}

fn opened_contexts_of(outcomes: &[NodeQueryOutcome]) -> Vec<RankingContext> {
    outcomes
        .iter()
        .filter_map(|outcome| {
            let context_id = outcome.results.as_ref()?.context_id.clone()?;
            Some(RankingContext {
                node_id: outcome.node_id.clone(),
                context_id,
            })
        })
        .collect()
}

pub(crate) async fn fan_out_search(
    deps: &Arc<ReadDeps>,
    search: SearchFanOut<'_>,
    routing: &PartitionRouting,
    config: &DistributedQueryConfig,
) -> ClusterResult<Vec<NodeQueryOutcome>> {
    let mut base = Map::with_capacity(6);
    base.insert("indexName", Value::from(search.index_name));
    base.insert("params", search.params);
    base.insert("globalStats", search.global_stats.unwrap_or(Value::Null));
    base.insert(
        "facetShardSize",
        search.facet_shard_size.map_or(Value::Null, Value::from),
    );
    if let Some(keep_alive_ms) = search.keep_alive_ms {
        base.insert("keepAliveMs", Value::from(keep_alive_ms));
    }
    let base = Arc::new(base);
    let index: Arc<str> = Arc::from(search.index_name);
    let timeout_ms = config.partition_timeout_ms;
    let attempt_deps = Arc::clone(deps);
    let attempt: Attempt<SearchAnswer> = Arc::new(move |node_id, partition_ids| {
        let deps = Arc::clone(&attempt_deps);
        let index = Arc::clone(&index);
        let mut payload = (*base).clone();
        payload.insert("partitionIds", partition_list(&partition_ids));
        Box::pin(async move {
            let message = request(&deps, message_types::QUERY_SEARCH, &payload)?;
            let late_deps = Arc::clone(&deps);
            let late_node = node_id.clone();
            let on_late: LateAnswer<SearchAnswer> = Box::new(move |late: SearchAnswer| {
                if let Some(context_id) = late.context_id {
                    let context = RankingContext {
                        node_id: late_node,
                        context_id,
                    };
                    release_search_contexts(&late_deps, &index, &[context]);
                }
            });
            send_with_timeout(
                &deps,
                node_id,
                message,
                timeout_ms,
                validate_search_result_payload,
                Some(on_late),
            )
            .await
        })
    });
    let outcomes = send_with_failover(routing, attempt).await;
    let every_partition_failed = outcomes
        .iter()
        .all(|outcome| outcome.status != OutcomeStatus::Success);
    let memory_refusal = outcomes.iter().find_map(|outcome| {
        outcome
            .error
            .as_ref()
            .filter(|failure| is_memory_refusal(failure))
    });
    let rejection = outcomes
        .iter()
        .find_map(|outcome| {
            outcome
                .error
                .as_ref()
                .filter(|failure| failure.node_rejection)
        })
        .or(memory_refusal.filter(|_| !config.allow_partial_results || every_partition_failed))
        .map(|failure| failure.error.clone());
    let outcomes: Vec<NodeQueryOutcome> = outcomes
        .into_iter()
        .map(|outcome| NodeQueryOutcome {
            node_id: outcome.node_id,
            partition_ids: outcome.partition_ids,
            status: outcome.status,
            results: outcome.result,
        })
        .collect();
    if let Some(error) = rejection {
        release_search_contexts(deps, search.index_name, &opened_contexts_of(&outcomes));
        return Err(error);
    }
    Ok(outcomes)
}

fn severity(status: OutcomeStatus) -> u8 {
    match status {
        OutcomeStatus::Success => 0,
        OutcomeStatus::Timeout => 1,
        OutcomeStatus::Failed => 2,
    }
}

pub(crate) fn build_coverage(
    total_partitions: usize,
    unavailable_partitions: &[u32],
    outcome_sets: &[&[NodeQueryOutcome]],
) -> QueryCoverage {
    let mut worst: HashMap<u32, OutcomeStatus> = HashMap::new();
    for partition_id in unavailable_partitions {
        worst.insert(*partition_id, OutcomeStatus::Failed);
    }
    for outcomes in outcome_sets {
        for outcome in outcomes.iter() {
            for partition_id in &outcome.partition_ids {
                let held = worst.entry(*partition_id).or_insert(outcome.status);
                if severity(outcome.status) > severity(*held) {
                    *held = outcome.status;
                }
            }
        }
    }
    let mut coverage = QueryCoverage {
        total_partitions,
        ..QueryCoverage::default()
    };
    for status in worst.values() {
        match status {
            OutcomeStatus::Success => coverage.queried_partitions += 1,
            OutcomeStatus::Timeout => coverage.timed_out_partitions += 1,
            OutcomeStatus::Failed => coverage.failed_partitions += 1,
        }
    }
    coverage
}
