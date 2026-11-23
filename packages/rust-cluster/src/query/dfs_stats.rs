use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use narsil::{Map, Value};
use tokio::task::JoinSet;

use super::failover::{Attempt, Failure, OutcomeStatus, send_with_failover};
use super::fan_out::{DistributedQueryConfig, partition_list, send_with_timeout, text_list};
use super::results::{invalid, whole_number};
use super::selection::PartitionRouting;
use super::version_routing::query_reads_phrases;
use super::wire_query::WireQuery;
use crate::constants::MAX_STATS_TOKENS;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::reads::ReadDeps;
use crate::reads::node_messaging::request;

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct StatsAnswer {
    pub(crate) total_documents: f64,
    pub(crate) doc_frequencies: BTreeMap<String, f64>,
    pub(crate) total_field_lengths: BTreeMap<String, f64>,
    pub(crate) expanded: Vec<String>,
}

fn numeric_record(value: Option<&Value>, label: &str) -> ClusterResult<BTreeMap<String, f64>> {
    let Some(Value::Object(entries)) = value else {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" must be an object"
        )));
    };
    let mut record = BTreeMap::new();
    for (key, entry) in entries.iter() {
        if key.is_empty() {
            return Err(invalid(format!(
                "Invalid payload: each \"{label}\" key must be a non-empty string"
            )));
        }
        match entry {
            Value::Number(number) if number.is_finite() && *number >= 0.0 => {
                record.insert(key.clone(), *number);
            }
            _ => {
                return Err(invalid(format!(
                    "Invalid payload: \"{label}.{key}\" must be a non-negative finite number"
                )));
            }
        }
    }
    Ok(record)
}

fn token_list(value: Option<&Value>, label: &str) -> ClusterResult<Vec<String>> {
    let tokens = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(tokens)) => tokens,
        Some(_) => {
            return Err(invalid(format!(
                "Invalid payload: \"{label}\" must be an array or absent"
            )));
        }
    };
    if tokens.len() > MAX_STATS_TOKENS {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" exceeds maximum length of {MAX_STATS_TOKENS}"
        ))
        .with_detail("length", Value::from(tokens.len()))
        .with_detail("limit", Value::from(MAX_STATS_TOKENS)));
    }
    tokens
        .iter()
        .map(|token| match token {
            Value::String(token) if !token.is_empty() => Ok(token.clone()),
            _ => Err(invalid(format!(
                "Invalid payload: each \"{label}\" entry must be a non-empty string"
            ))),
        })
        .collect()
}

pub(crate) fn validate_stats_result_payload(decoded: Map) -> ClusterResult<StatsAnswer> {
    let Some(total_documents) =
        whole_number(decoded.get("totalDocuments")).filter(|total| *total >= 0.0)
    else {
        return Err(invalid(
            "Invalid StatsResultPayload: \"totalDocuments\" must be a non-negative integer"
                .to_string(),
        ));
    };
    Ok(StatsAnswer {
        total_documents,
        doc_frequencies: numeric_record(
            decoded.get("docFrequencies"),
            "StatsResultPayload.docFrequencies",
        )?,
        total_field_lengths: numeric_record(
            decoded.get("totalFieldLengths"),
            "StatsResultPayload.totalFieldLengths",
        )?,
        expanded: token_list(decoded.get("expanded"), "StatsResultPayload.expanded")?,
    })
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct GlobalStatistics {
    pub(crate) total_documents: f64,
    pub(crate) doc_frequencies: BTreeMap<String, f64>,
    pub(crate) total_field_lengths: BTreeMap<String, f64>,
    pub(crate) average_field_lengths: BTreeMap<String, f64>,
}

fn numbers(record: &BTreeMap<String, f64>) -> Value {
    let mut map = Map::with_capacity(record.len());
    for (key, number) in record {
        map.insert(key.as_str(), Value::Number(*number));
    }
    Value::Object(map)
}

impl GlobalStatistics {
    pub(crate) fn to_value(&self) -> Value {
        let mut value = Map::with_capacity(4);
        value.insert("totalDocuments", Value::Number(self.total_documents));
        value.insert("docFrequencies", numbers(&self.doc_frequencies));
        value.insert("totalFieldLengths", numbers(&self.total_field_lengths));
        value.insert("averageFieldLengths", numbers(&self.average_field_lengths));
        Value::Object(value)
    }
}

pub(crate) fn merge_partition_stats(stats: &[StatsAnswer]) -> GlobalStatistics {
    let mut merged = GlobalStatistics::default();
    for answer in stats {
        merged.total_documents += answer.total_documents;
        for (term, frequency) in &answer.doc_frequencies {
            *merged.doc_frequencies.entry(term.clone()).or_insert(0.0) += frequency;
        }
        for (field, length) in &answer.total_field_lengths {
            *merged
                .total_field_lengths
                .entry(field.clone())
                .or_insert(0.0) += length;
        }
    }
    if merged.total_documents > 0.0 {
        for (field, total) in &merged.total_field_lengths {
            merged
                .average_field_lengths
                .insert(field.clone(), total / merged.total_documents);
        }
    }
    merged
}

fn stats_expansion_of(wire: &WireQuery) -> Value {
    let flag = |flag: Option<bool>| flag.map_or(Value::Null, Value::Bool);
    let mut expansion = Map::with_capacity(6);
    expansion.insert("tolerance", wire.tolerance.map_or(Value::Null, Value::from));
    expansion.insert(
        "prefixLength",
        wire.prefix_length.map_or(Value::Null, Value::from),
    );
    expansion.insert("prefix", flag(wire.prefix));
    expansion.insert("partialWords", flag(wire.partial_words));
    expansion.insert("exact", flag(wire.exact));
    expansion.insert(
        "fields",
        wire.fields.as_ref().map_or(Value::Null, text_list),
    );
    Value::Object(expansion)
}

struct StatsRequest {
    index_name: String,
    analysis_generation: Option<u64>,
    timeout_ms: u64,
}

async fn request_stats(
    deps: &Arc<ReadDeps>,
    node_id: String,
    mut payload: Map,
    stats: &StatsRequest,
) -> Result<Option<StatsAnswer>, Failure> {
    payload.insert("indexName", Value::from(stats.index_name.as_str()));
    if let Some(generation) = stats.analysis_generation {
        payload.insert("analysisGeneration", Value::from(generation));
    }
    let message = request(deps, message_types::QUERY_STATS, &payload)?;
    send_with_timeout(
        deps,
        node_id,
        message,
        stats.timeout_ms,
        validate_stats_result_payload,
        None,
    )
    .await
}

async fn count_left_out_tokens(
    deps: &Arc<ReadDeps>,
    answered: &[(String, Vec<u32>, StatsAnswer)],
    stats: &Arc<StatsRequest>,
) -> Vec<StatsAnswer> {
    let reached: BTreeSet<&String> = answered
        .iter()
        .flat_map(|(_, _, answer)| &answer.expanded)
        .collect();
    if reached.is_empty() {
        return Vec::new();
    }
    let mut counting = JoinSet::new();
    for (node_id, partition_ids, answer) in answered {
        let tokens: Vec<String> = reached
            .iter()
            .filter(|token| !answer.doc_frequencies.contains_key(token.as_str()))
            .map(|token| (*token).clone())
            .collect();
        if tokens.is_empty() {
            continue;
        }
        let mut payload = Map::with_capacity(5);
        payload.insert("partitionIds", partition_list(partition_ids));
        payload.insert("terms", Value::Array(Vec::new()));
        payload.insert("tokens", text_list(&tokens));
        let (deps, stats, node_id) = (Arc::clone(deps), Arc::clone(stats), node_id.clone());
        counting.spawn(async move {
            let counted = request_stats(&deps, node_id, payload, &stats).await;
            let Ok(Some(counted)) = counted else {
                return None;
            };
            let doc_frequencies = tokens
                .iter()
                .filter_map(|token| {
                    let frequency = counted.doc_frequencies.get(token)?;
                    Some((token.clone(), *frequency))
                })
                .collect();
            Some(StatsAnswer {
                total_documents: 0.0,
                doc_frequencies,
                total_field_lengths: BTreeMap::new(),
                expanded: Vec::new(),
            })
        });
    }
    let mut extra = Vec::new();
    while let Some(joined) = counting.join_next().await {
        if let Ok(Some(counted)) = joined {
            extra.push(counted);
        }
    }
    extra
}

fn query_terms(term: Option<&str>) -> Vec<String> {
    term.map(|term| {
        term.split(|character: char| character.is_whitespace() || character == '\u{feff}')
            .filter(|word| !word.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

pub(crate) async fn collect_distributed_stats(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    wire: &WireQuery,
    routing: &PartitionRouting,
    config: &DistributedQueryConfig,
) -> ClusterResult<GlobalStatistics> {
    if routing.node_to_partitions.is_empty() && query_reads_phrases(wire.term.as_deref()) {
        return Ok(merge_partition_stats(&[]));
    }
    let stats = Arc::new(StatsRequest {
        index_name: index_name.to_string(),
        analysis_generation: wire.analysis_generation,
        timeout_ms: config.partition_timeout_ms,
    });
    let mut base = Map::with_capacity(5);
    base.insert("terms", text_list(&query_terms(wire.term.as_deref())));
    base.insert("expansion", stats_expansion_of(wire));
    let base = Arc::new(base);
    let attempt_deps = Arc::clone(deps);
    let attempt_stats = Arc::clone(&stats);
    let attempt: Attempt<StatsAnswer> = Arc::new(move |node_id, partition_ids| {
        let deps = Arc::clone(&attempt_deps);
        let stats = Arc::clone(&attempt_stats);
        let mut payload = (*base).clone();
        payload.insert("partitionIds", partition_list(&partition_ids));
        Box::pin(async move { request_stats(&deps, node_id, payload, &stats).await })
    });
    let outcomes = send_with_failover(routing, attempt).await;
    if let Some(refused) = outcomes.iter().find_map(|outcome| {
        outcome.error.as_ref().filter(|failure| {
            failure.node_rejection && failure.error.code() == codes::ANALYSIS_GENERATION_MISSING
        })
    }) {
        return Err(refused.error.clone());
    }
    let answered: Vec<(String, Vec<u32>, StatsAnswer)> = outcomes
        .into_iter()
        .filter(|outcome| outcome.status == OutcomeStatus::Success)
        .filter_map(|outcome| Some((outcome.node_id, outcome.partition_ids, outcome.result?)))
        .collect();
    if answered.is_empty() {
        return Err(ClusterError::new(
            codes::QUERY_NODE_TIMEOUT,
            "All partition stats requests failed during DFS pre-pass",
        )
        .with_detail("nodeCount", Value::from(routing.node_to_partitions.len())));
    }
    let left_out = count_left_out_tokens(deps, &answered, &stats).await;
    let mut gathered: Vec<StatsAnswer> =
        answered.into_iter().map(|(_, _, answer)| answer).collect();
    gathered.extend(left_out);
    Ok(merge_partition_stats(&gathered))
}
