use std::sync::Arc;

use narsil::partitions::{PartitionQuery, StatsExpansion};
use narsil::{Map, Value};

use super::QueryDeps;
use super::payload::{
    absent, analysis_generation, answer, bounded_integer, index_name, invalid, partition_ids,
    request_fields, string_list,
};
use super::refusal::{ServedRead, refuse_unserved_read};
use crate::constants::{
    MAX_FIELD_NAME_LENGTH, MAX_FIELDS_LIST, MAX_PREFIX_LENGTH, MAX_STATS_TOKENS, MAX_TERM_LENGTH,
    MAX_TERMS_COUNT, MAX_TOLERANCE,
};
use crate::data::blocking::off_executor;
use crate::error::{ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

const STATS_PAYLOAD: &str = "StatsPayload";

fn expansion(value: Option<&Value>) -> ClusterResult<Option<StatsExpansion>> {
    if absent(value) {
        return Ok(None);
    }
    let Some(Value::Object(fields)) = value else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            "Invalid StatsPayload: \"expansion\" must be an object or absent",
        ));
    };
    let flag = |name: &str| -> ClusterResult<Option<bool>> {
        match fields.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(flag)) => Ok(Some(*flag)),
            Some(_) => Err(invalid(
                codes::CONFIG_INVALID,
                format!("Invalid StatsPayload: \"expansion.{name}\" must be a boolean or absent"),
            )),
        }
    };
    Ok(Some(StatsExpansion {
        tolerance: bounded_integer(
            fields.get("tolerance"),
            "expansion.tolerance",
            MAX_TOLERANCE,
            STATS_PAYLOAD,
        )?,
        prefix_length: bounded_integer(
            fields.get("prefixLength"),
            "expansion.prefixLength",
            MAX_PREFIX_LENGTH,
            STATS_PAYLOAD,
        )?,
        prefix: flag("prefix")?,
        partial_words: flag("partialWords")?,
        exact: flag("exact")?,
        fields: match fields.get("fields") {
            None | Some(Value::Null) => None,
            listed => Some(string_list(
                listed,
                "expansion.fields",
                MAX_FIELDS_LIST,
                MAX_FIELD_NAME_LENGTH,
                codes::CONFIG_INVALID,
            )?),
        },
    }))
}

fn tokens(value: Option<&Value>) -> ClusterResult<Vec<String>> {
    let label = "StatsPayload.tokens";
    if absent(value) {
        return Ok(Vec::new());
    }
    let Some(Value::Array(items)) = value else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid payload: \"{label}\" must be an array or absent"),
        ));
    };
    if items.len() > MAX_STATS_TOKENS {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid payload: \"{label}\" exceeds maximum length of {MAX_STATS_TOKENS}"),
        )
        .with_detail("length", Value::from(items.len()))
        .with_detail("limit", Value::from(MAX_STATS_TOKENS)));
    }
    items
        .iter()
        .map(|item| match item {
            Value::String(token) if !token.is_empty() => Ok(token.clone()),
            _ => Err(invalid(
                codes::CONFIG_INVALID,
                format!("Invalid payload: each \"{label}\" entry must be a non-empty string"),
            )),
        })
        .collect()
}

pub(super) async fn answer_stats(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let fields = request_fields(message, STATS_PAYLOAD)?;
    let index_name = index_name(&fields, STATS_PAYLOAD)?;
    let partition_ids = partition_ids(&fields)?;
    let terms = string_list(
        fields.get("terms"),
        "terms",
        MAX_TERMS_COUNT,
        MAX_TERM_LENGTH,
        codes::CONFIG_INVALID,
    )?;
    let expansion = expansion(fields.get("expansion"))?;
    let tokens = tokens(fields.get("tokens"))?;
    let generation = analysis_generation(&fields, STATS_PAYLOAD)?;
    refuse_unserved_read(
        &deps.view,
        deps.node_id,
        &index_name,
        &partition_ids,
        ServedRead::Query,
    )
    .await?;
    let copies = Arc::clone(&deps.copies);
    let confinement = PartitionQuery {
        partition_ids,
        ..PartitionQuery::default()
    };
    let read_index = index_name.clone();
    let collected = deps
        .analysis
        .answer_at(&index_name, generation, || async move {
            off_executor(move || {
                copies.stats_partitions(
                    &read_index,
                    &confinement,
                    &terms,
                    expansion.as_ref(),
                    &tokens,
                )
            })
            .await?
        })
        .await?;
    let mut payload = Map::with_capacity(4);
    payload.insert("totalDocuments", Value::from(collected.total_documents));
    let mut frequencies = Map::with_capacity(collected.doc_frequencies.len());
    for (token, documents) in collected.doc_frequencies {
        frequencies.insert(token.as_str(), Value::from(documents));
    }
    payload.insert("docFrequencies", Value::Object(frequencies));
    let mut lengths = Map::with_capacity(collected.total_field_lengths.len());
    for (field, length) in collected.total_field_lengths {
        lengths.insert(field.as_str(), Value::from(length));
    }
    payload.insert("totalFieldLengths", Value::Object(lengths));
    if !collected.expanded.is_empty() {
        payload.insert(
            "expanded",
            Value::Array(collected.expanded.into_iter().map(Value::String).collect()),
        );
    }
    answer(
        message,
        message_types::QUERY_STATS_RESULT,
        deps.node_id,
        payload,
    )
}
