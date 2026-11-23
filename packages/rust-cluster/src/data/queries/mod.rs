mod count;
mod fetch;
mod list;
mod payload;
mod preflight;
mod projection;
mod refusal;
mod search;
mod sort;
mod stats;
mod suggest;
mod wire_options;
mod wire_params;
mod wire_values;

use std::sync::Arc;

use super::copies::LocalCopies;
use super::search_contexts::SearchContexts;
use super::writes::AllocationView;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

pub(super) struct QueryDeps<'a> {
    pub(super) node_id: &'a str,
    pub(super) copies: Arc<LocalCopies>,
    pub(super) view: Arc<AllocationView>,
    pub(super) contexts: Arc<SearchContexts>,
}

pub(super) fn answers_query(message_type: &str) -> bool {
    matches!(
        message_type,
        message_types::QUERY_SEARCH
            | message_types::QUERY_FETCH
            | message_types::QUERY_STATS
            | message_types::QUERY_COUNT
            | message_types::QUERY_LIST
            | message_types::QUERY_SUGGEST
            | message_types::QUERY_PREFLIGHT
    )
}

pub(super) async fn answer_query(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    match message.message_type.as_str() {
        message_types::QUERY_SEARCH => search::answer_search(deps, message).await,
        message_types::QUERY_FETCH => fetch::answer_fetch(deps, message).await,
        message_types::QUERY_STATS => stats::answer_stats(deps, message).await,
        message_types::QUERY_COUNT => count::answer_count(deps, message).await,
        message_types::QUERY_LIST => list::answer_list(deps, message).await,
        message_types::QUERY_SUGGEST => suggest::answer_suggest(deps, message).await,
        message_types::QUERY_PREFLIGHT => preflight::answer_preflight(deps, message).await,
        other => Err(ClusterError::new(
            codes::INTERNAL_ERROR,
            format!("The data node routed a {other} message to its query handlers"),
        )),
    }
}
