use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use narsil::{Map, SuggestParams, SuggestResult, SuggestedTerm, Value};

use super::node_messaging::request;
use super::routable_allocation::routable_allocation;
use super::scatter::{gather_from_every_partition, send_read_request};
use super::{ReadDeps, rerun_on_newer_generation};
use crate::constants::{
    DEFAULT_SUGGEST_LIMIT, MAX_SUGGEST_LIMIT, MAX_SUGGEST_SCATTER_LIMIT, SUGGEST_OVERSAMPLE_FACTOR,
    SUGGEST_OVERSAMPLE_PADDING,
};
use crate::error::ClusterResult;
use crate::message::message_types;
use crate::query::results::validate_suggest_result_payload;

const BYTE_ORDER_MARK: char = '\u{feff}';

pub(crate) fn suggest_node_limit(client_limit: usize) -> usize {
    let oversampled = (client_limit as f64 * SUGGEST_OVERSAMPLE_FACTOR).ceil() as usize
        + SUGGEST_OVERSAMPLE_PADDING;
    oversampled.min(MAX_SUGGEST_SCATTER_LIMIT)
}

pub(crate) fn trimmed(text: &str) -> &str {
    text.trim_matches(|character: char| character.is_whitespace() || character == BYTE_ORDER_MARK)
}

fn suggest_payload(
    index_name: &str,
    partition_ids: &[u32],
    prefix: &str,
    limit: usize,
    analysis_generation: u64,
) -> Map {
    let mut payload = Map::with_capacity(5);
    payload.insert("indexName", Value::from(index_name));
    payload.insert(
        "partitionIds",
        Value::Array(partition_ids.iter().map(|id| Value::from(*id)).collect()),
    );
    payload.insert("prefix", Value::from(prefix));
    payload.insert("limit", Value::from(limit));
    payload.insert("analysisGeneration", Value::from(analysis_generation));
    payload
}

pub(crate) async fn suggest_cluster(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    params: &SuggestParams,
) -> ClusterResult<SuggestResult> {
    let table = routable_allocation(deps, index_name).await?;
    let start_time = Instant::now();
    let client_limit = params
        .limit
        .unwrap_or(DEFAULT_SUGGEST_LIMIT)
        .clamp(1, MAX_SUGGEST_LIMIT);
    let prefix = trimmed(&params.prefix).to_string();
    if prefix.is_empty() {
        return Ok(SuggestResult {
            terms: Vec::new(),
            elapsed: start_time.elapsed(),
            analysis_stale: false,
        });
    }
    let node_limit = suggest_node_limit(client_limit);
    let prefix: Arc<str> = Arc::from(prefix);
    let index: Arc<str> = Arc::from(index_name);
    let gathered = rerun_on_newer_generation(deps, index_name, || {
        let deps = Arc::clone(deps);
        let prefix = Arc::clone(&prefix);
        let index = Arc::clone(&index);
        let table = &table;
        async move {
            let analysis_generation = deps.analysis_view.generation_for(&index).await?;
            let scatter_deps = Arc::clone(&deps);
            let scatter_index = Arc::clone(&index);
            gather_from_every_partition(
                &deps,
                table,
                &scatter_index,
                move |group| {
                    let deps = Arc::clone(&scatter_deps);
                    let prefix = Arc::clone(&prefix);
                    let index = Arc::clone(&index);
                    async move {
                        let payload = suggest_payload(
                            &index,
                            &group.partition_ids,
                            &prefix,
                            node_limit,
                            analysis_generation,
                        );
                        let message = request(&deps, message_types::QUERY_SUGGEST, &payload)?;
                        send_read_request(
                            &deps,
                            &group.node_id,
                            &message,
                            &index,
                            validate_suggest_result_payload,
                            false,
                        )
                        .await
                    }
                },
                true,
            )
            .await
            .map_err(|failure| failure.error)
        }
    })
    .await?;

    let mut merged: HashMap<String, u64> = HashMap::new();
    let mut analysis_stale = false;
    for result in gathered {
        analysis_stale = analysis_stale || result.analysis_stale;
        for (term, frequency) in result.terms {
            let held = merged.entry(term).or_insert(0);
            *held = held.saturating_add(frequency);
        }
    }
    let mut terms: Vec<SuggestedTerm> = merged
        .into_iter()
        .map(|(term, document_frequency)| SuggestedTerm {
            term,
            document_frequency,
        })
        .collect();
    terms.sort_by(|left, right| {
        right
            .document_frequency
            .cmp(&left.document_frequency)
            .then_with(|| left.term.cmp(&right.term))
    });
    terms.truncate(client_limit);
    Ok(SuggestResult {
        terms,
        elapsed: start_time.elapsed(),
        analysis_stale,
    })
}
