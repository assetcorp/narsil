use std::sync::Arc;

use narsil::{Map, SuggestParams, Value};

use super::QueryDeps;
use super::payload::{
    analysis_generation, answer, index_name, partition_ids, positive_integer, request_fields,
    string_field,
};
use super::refusal::{ServedRead, refuse_unserved_read};
use crate::constants::{MAX_SUGGEST_WIRE_LIMIT, MAX_TERM_LENGTH};
use crate::data::blocking::off_executor;
use crate::error::{ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

const SUGGEST_PAYLOAD: &str = "SuggestPayload";

pub(super) async fn answer_suggest(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let fields = request_fields(message, SUGGEST_PAYLOAD)?;
    let index_name = index_name(&fields, SUGGEST_PAYLOAD)?;
    let partition_ids = partition_ids(&fields)?;
    let prefix = string_field(
        fields.get("prefix"),
        "prefix",
        MAX_TERM_LENGTH,
        codes::CONFIG_INVALID,
    )?;
    let limit = positive_integer(
        fields.get("limit"),
        "limit",
        MAX_SUGGEST_WIRE_LIMIT,
        codes::CONFIG_INVALID,
    )?;
    let generation = analysis_generation(&fields, SUGGEST_PAYLOAD)?;
    refuse_unserved_read(
        &deps.view,
        deps.node_id,
        &index_name,
        &partition_ids,
        ServedRead::Query,
    )
    .await?;
    let copies = Arc::clone(&deps.copies);
    let params = SuggestParams {
        prefix,
        limit: Some(limit as usize),
    };
    let read_index = index_name.clone();
    let suggested = deps
        .analysis
        .answer_at(&index_name, generation, || async move {
            off_executor(move || copies.suggest_partitions(&read_index, &params, &partition_ids))
                .await?
        })
        .await?;
    let terms = suggested
        .terms
        .into_iter()
        .map(|suggestion| {
            let mut entry = Map::with_capacity(2);
            entry.insert("term", Value::String(suggestion.term));
            entry.insert(
                "documentFrequency",
                Value::from(suggestion.document_frequency),
            );
            Value::Object(entry)
        })
        .collect();
    let mut payload = Map::with_capacity(2);
    payload.insert("terms", Value::Array(terms));
    payload.insert("analysisStale", Value::Bool(suggested.analysis_stale));
    answer(
        message,
        message_types::QUERY_SUGGEST_RESULT,
        deps.node_id,
        payload,
    )
}
