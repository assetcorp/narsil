use std::collections::HashMap;
use std::sync::Arc;

use narsil::{Map, Value};

use super::search_answer::SearchAnswer;
use super::selection::PartitionRouting;
use crate::constants::{SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS, SEARCH_CONTEXT_KEEP_ALIVE_MS};
use crate::message::message_types;
use crate::reads::ReadDeps;
use crate::reads::node_messaging::{SendFailureContext, request, send_to_node};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RankingContext {
    pub(crate) node_id: String,
    pub(crate) context_id: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SearchContextSet {
    pub(crate) sources: HashMap<String, RankingContext>,
    pub(crate) opened: Vec<RankingContext>,
}

pub(crate) fn search_context_keep_alive(
    routing: &PartitionRouting,
    partition_timeout_ms: u64,
    request_timeout_ms: u64,
) -> u64 {
    let copies = routing
        .copies_by_partition
        .values()
        .map(Vec::len)
        .fold(1, usize::max) as u64;
    let longest_gap = partition_timeout_ms
        .saturating_mul(copies)
        .saturating_add(request_timeout_ms.saturating_mul(2));
    longest_gap.clamp(
        SEARCH_CONTEXT_KEEP_ALIVE_MS,
        SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS,
    )
}

pub(crate) fn collect_search_contexts<'a>(
    answered: impl IntoIterator<Item = (&'a str, &'a SearchAnswer)>,
) -> SearchContextSet {
    let mut set = SearchContextSet::default();
    for (node_id, answer) in answered {
        let Some(context_id) = &answer.context_id else {
            continue;
        };
        let context = RankingContext {
            node_id: node_id.to_string(),
            context_id: context_id.clone(),
        };
        set.opened.push(context.clone());
        let partition_entries = answer.results.iter().flat_map(|result| &result.scored);
        let group_entries = answer
            .groups
            .iter()
            .flatten()
            .flat_map(|group| &group.scored);
        for entry in partition_entries.chain(group_entries) {
            set.sources
                .entry(entry.doc_id.clone())
                .or_insert_with(|| context.clone());
        }
    }
    set
}

pub(crate) fn release_search_contexts(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    contexts: &[RankingContext],
) {
    for context in contexts {
        let mut payload = Map::with_capacity(6);
        payload.insert("indexName", Value::from(index_name));
        payload.insert("documentIds", Value::Array(Vec::new()));
        payload.insert("fields", Value::Null);
        payload.insert("highlight", Value::Null);
        payload.insert("contextId", Value::from(context.context_id.as_str()));
        payload.insert("releaseContext", Value::Bool(true));
        let Ok(message) = request(deps, message_types::QUERY_FETCH, &payload) else {
            continue;
        };
        let deps = Arc::clone(deps);
        let node_id = context.node_id.clone();
        let index_name = index_name.to_string();
        tokio::spawn(async move {
            let failure = SendFailureContext {
                message: format!(
                    "Node '{node_id}' did not answer a search context release for index '{index_name}'"
                ),
                index_name: Some(index_name.clone()),
            };
            let _released = send_to_node(&deps, &node_id, &message, &failure).await;
        });
    }
}
