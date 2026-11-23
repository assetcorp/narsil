use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use narsil::partitions::{PartitionQuery, SuppliedStatistics};
use narsil::{
    DocumentProjection, FacetResult, GroupResult, Hit, Map, QueryResult, SortField, Value,
};

use super::QueryDeps;
use super::payload::{
    absent, index_name, invalid, partition_ids, request_fields, require_held_generation,
};
use super::refusal::{ServedRead, refuse_unserved_read};
use super::sort::wire_sort_values;
use super::wire_params::{WireParams, wire_params};
use crate::constants::{GROUP_OVERSAMPLE_FACTOR, GROUP_OVERSAMPLE_PADDING, MAX_FACET_SHARD_SIZE};
use crate::data::blocking::off_executor;
use crate::data::search_contexts::{RankedDocuments, keep_alive_of};
use crate::error::{ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

const SEARCH_PAYLOAD: &str = "SearchPayload";

fn oversampled_shard_size(size: usize) -> usize {
    (size as f64 * GROUP_OVERSAMPLE_FACTOR).ceil() as usize + GROUP_OVERSAMPLE_PADDING
}

fn numeric_record(value: Option<&Value>, label: &str) -> ClusterResult<Vec<(String, f64)>> {
    let Some(Value::Object(entries)) = value else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid {SEARCH_PAYLOAD}: \"globalStats.{label}\" must be an object"),
        ));
    };
    let mut figures = Vec::with_capacity(entries.len());
    for (key, figure) in entries.iter() {
        match figure {
            Value::Number(number) if number.is_finite() && *number >= 0.0 && !key.is_empty() => {
                figures.push((key.clone(), *number));
            }
            _ => {
                return Err(invalid(
                    codes::CONFIG_INVALID,
                    format!(
                        "Invalid payload: \"GlobalStatistics.{label}.{key}\" must be a non-negative finite number"
                    ),
                ));
            }
        }
    }
    Ok(figures)
}

fn global_stats(value: Option<&Value>) -> ClusterResult<Option<SuppliedStatistics>> {
    if absent(value) {
        return Ok(None);
    }
    let Some(Value::Object(fields)) = value else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            "Invalid SearchPayload: \"globalStats\" must be an object or null",
        ));
    };
    let total_documents = match fields.get("totalDocuments") {
        Some(Value::Number(total)) if total.is_finite() && *total >= 0.0 => *total,
        _ => {
            return Err(invalid(
                codes::CONFIG_INVALID,
                "Invalid SearchPayload: \"globalStats.totalDocuments\" must be a non-negative number",
            ));
        }
    };
    let doc_frequencies: HashMap<String, f64> =
        numeric_record(fields.get("docFrequencies"), "docFrequencies")?
            .into_iter()
            .collect();
    numeric_record(fields.get("totalFieldLengths"), "totalFieldLengths")?;
    let average_field_lengths: BTreeMap<String, f64> = match fields.get("averageFieldLengths") {
        None | Some(Value::Null) => BTreeMap::new(),
        averages => numeric_record(averages, "averageFieldLengths")?
            .into_iter()
            .collect(),
    };
    Ok(Some(SuppliedStatistics {
        total_documents,
        doc_frequencies,
        average_field_lengths,
    }))
}

fn facet_shard_size(value: Option<&Value>) -> ClusterResult<Option<usize>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(size))
            if size.is_finite() && (1.0..=MAX_FACET_SHARD_SIZE).contains(size) =>
        {
            Ok(Some(*size as usize))
        }
        Some(_) => Err(invalid(
            codes::CONFIG_INVALID,
            format!(
                "Invalid SearchPayload: \"facetShardSize\" must be between 1 and {MAX_FACET_SHARD_SIZE}, or null"
            ),
        )),
    }
}

fn keep_alive(value: Option<&Value>) -> ClusterResult<Option<u64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(ms)) if ms.fract() == 0.0 && *ms > 0.0 => Ok(Some(*ms as u64)),
        Some(_) => Err(invalid(
            codes::CONFIG_INVALID,
            "Invalid SearchPayload: \"keepAliveMs\" must be a positive integer, or null",
        )),
    }
}

fn scored_entry(hit: &Hit, sort: Option<&[SortField]>) -> ClusterResult<Value> {
    let mut entry = Map::with_capacity(3);
    entry.insert("docId", Value::String(hit.id.clone()));
    entry.insert("score", hit.score.map_or(Value::Null, Value::Number));
    let sort_values = match sort {
        None => Value::Null,
        Some(sort) => wire_sort_values(Some(&hit.document), sort)?,
    };
    entry.insert("sortValues", sort_values);
    Ok(Value::Object(entry))
}

fn wire_facets(facets: Option<&Vec<(String, FacetResult)>>) -> (Value, Value) {
    let Some(facets) = facets else {
        return (Value::Null, Value::Null);
    };
    let mut buckets = Map::with_capacity(facets.len());
    let mut bounds = Map::with_capacity(facets.len());
    for (field, facet) in facets {
        let values = facet
            .values
            .iter()
            .map(|(value, count)| {
                let mut bucket = Map::with_capacity(2);
                bucket.insert("value", Value::String(value.clone()));
                bucket.insert("count", Value::from(*count));
                Value::Object(bucket)
            })
            .collect();
        buckets.insert(field.as_str(), Value::Array(values));
        bounds.insert(field.as_str(), Value::from(facet.error_bound));
    }
    (Value::Object(buckets), Value::Object(bounds))
}

fn wire_groups(
    groups: Option<&Vec<GroupResult>>,
    sort: Option<&[SortField]>,
) -> ClusterResult<Value> {
    let Some(groups) = groups else {
        return Ok(Value::Null);
    };
    let mut wire = Vec::with_capacity(groups.len());
    for group in groups {
        let mut values = Map::with_capacity(group.values.len());
        for (field, value) in &group.values {
            values.insert(field.as_str(), value.clone().unwrap_or(Value::Null));
        }
        let scored = group
            .hits
            .iter()
            .map(|hit| scored_entry(hit, sort))
            .collect::<ClusterResult<Vec<Value>>>()?;
        let mut entry = Map::with_capacity(2);
        entry.insert("values", Value::Object(values));
        entry.insert("scored", Value::Array(scored));
        wire.push(Value::Object(entry));
    }
    Ok(Value::Array(wire))
}

fn open_context(
    deps: &QueryDeps<'_>,
    coordinator_node_id: &str,
    result: &QueryResult,
    vector_paths: Vec<String>,
    keep_alive_ms: u64,
) -> ClusterResult<Option<String>> {
    let mut documents: HashMap<String, Map> = HashMap::new();
    let grouped = result.groups.iter().flatten().flat_map(|group| &group.hits);
    for hit in result.hits.iter().chain(grouped) {
        documents
            .entry(hit.id.clone())
            .or_insert_with(|| hit.document.clone());
    }
    if documents.is_empty() {
        return Ok(None);
    }
    let ranked = RankedDocuments {
        documents,
        vector_paths,
    };
    deps.contexts
        .open(coordinator_node_id, keep_alive_of(keep_alive_ms), ranked)
        .map(Some)
}

pub(super) async fn answer_search(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let fields = request_fields(message, SEARCH_PAYLOAD)?;
    let index_name = index_name(&fields, SEARCH_PAYLOAD)?;
    let partition_ids = partition_ids(&fields)?;
    let shard_size = facet_shard_size(fields.get("facetShardSize"))?;
    let WireParams {
        mut params,
        index_bm25,
        analysis_generation,
        rescore_window,
    } = wire_params(fields.get("params"), shard_size)?;
    let global = global_stats(fields.get("globalStats"))?;
    let keep_alive_ms = keep_alive(fields.get("keepAliveMs"))?;
    refuse_unserved_read(
        &deps.view,
        deps.node_id,
        &index_name,
        &partition_ids,
        ServedRead::Query,
    )
    .await?;
    if let Some(group) = params.group.as_mut()
        && let Some(limit) = group.limit
    {
        group.limit = Some(oversampled_shard_size(limit));
    }
    if keep_alive_ms.is_some() {
        params.document = Some(DocumentProjection::Fields {
            include: None,
            exclude: None,
            vectors: Some(true),
        });
    } else if params.sort.is_none() {
        params.document = Some(DocumentProjection::None);
    }
    require_held_generation(&index_name, analysis_generation)?;
    let confinement = PartitionQuery {
        partition_ids: partition_ids.clone(),
        global_stats: global,
        rescore_window,
        index_bm25,
    };
    let copies = Arc::clone(&deps.copies);
    let holds_context = keep_alive_ms.is_some();
    let (result, params, vector_paths) = off_executor(move || {
        let result = copies.query_partitions(&index_name, &params, &confinement);
        let vector_paths = match holds_context {
            true => copies.vector_fields(&index_name),
            false => Ok(Vec::new()),
        };
        (result, params, vector_paths)
    })
    .await?;
    let result = result?;
    let context_id = match keep_alive_ms {
        None => None,
        Some(ms) => Some(open_context(
            deps,
            &message.source_id,
            &result,
            vector_paths?,
            ms,
        )?),
    };
    let sort = params.sort.as_deref();
    let scored = result
        .hits
        .iter()
        .map(|hit| scored_entry(hit, sort))
        .collect::<ClusterResult<Vec<Value>>>()?;
    let mut scored = Some(scored);
    let results = partition_ids
        .iter()
        .enumerate()
        .map(|(at, partition_id)| {
            let mut entry = Map::with_capacity(3);
            entry.insert("partitionId", Value::from(*partition_id));
            let first = at == 0;
            let entries = match first {
                true => scored.take().unwrap_or_default(),
                false => Vec::new(),
            };
            entry.insert("scored", Value::Array(entries));
            entry.insert(
                "totalHits",
                Value::from(if first { result.count } else { 0 }),
            );
            Value::Object(entry)
        })
        .collect();
    let (facets, facet_error_bounds) = wire_facets(result.facets.as_ref());
    let mut payload = Map::with_capacity(4);
    payload.insert("results", Value::Array(results));
    payload.insert("facets", facets);
    payload.insert("facetErrorBounds", facet_error_bounds);
    payload.insert("groups", wire_groups(result.groups.as_ref(), sort)?);
    if let Some(context_id) = context_id {
        payload.insert("contextId", context_id.map_or(Value::Null, Value::String));
    }
    super::payload::answer(
        message,
        message_types::QUERY_SEARCH_RESULT,
        deps.node_id,
        payload,
    )
}
