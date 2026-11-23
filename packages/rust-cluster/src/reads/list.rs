use std::sync::Arc;
use std::time::Instant;

use narsil::coordination::{
    CoordinatedCursor, SortKeyOrder, comparable_sort_value, decode_cursor, encode_cursor,
    listing_binding, sort_signature,
};
use narsil::{ListParams, ListResult, ListedDocument, Map, SortDirection, SortField, Value};

use super::ReadDeps;
use super::node_messaging::request;
use super::projection::{
    ResolvedProjection, apply_projection, keeps_any_vector_field, resolve_projection,
};
use super::routable_allocation::routable_allocation;
use super::scatter::{gather_from_every_partition, send_read_request};
use crate::constants::{DEFAULT_PAGE_SIZE, RESULT_WINDOW};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::query::results::{ListEntryWire, validate_list_result_payload};

pub(crate) fn require_within_result_window(limit: usize, offset: usize) -> ClusterResult<()> {
    let depth = offset.saturating_add(limit);
    if depth <= RESULT_WINDOW {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::SEARCH_RESULT_WINDOW_EXCEEDED,
        format!(
            "A request reaches the first {RESULT_WINDOW} results, and offset + limit is {depth}. Page past that with the cursor each result carries"
        ),
    )
    .with_detail("limit", Value::from(limit))
    .with_detail("offset", Value::from(offset))
    .with_detail("window", Value::from(RESULT_WINDOW)))
}

fn clamp_list_limit(limit: Option<usize>) -> ClusterResult<usize> {
    let clamped = limit.unwrap_or(DEFAULT_PAGE_SIZE).max(1);
    require_within_result_window(clamped, 0)?;
    Ok(clamped)
}

fn wire_fields_for(
    projection: &ResolvedProjection,
    sort_field_names: &[String],
) -> Option<Vec<String>> {
    match projection {
        ResolvedProjection::Nothing => Some(sort_field_names.to_vec()),
        ResolvedProjection::Fields {
            include: Some(include),
            ..
        } => {
            let mut fields: Vec<String> =
                Vec::with_capacity(include.len() + sort_field_names.len());
            for path in include {
                let joined = path.join(".");
                if !fields.contains(&joined) {
                    fields.push(joined);
                }
            }
            for sort_field in sort_field_names {
                if !fields.contains(sort_field) {
                    fields.push(sort_field.clone());
                }
            }
            Some(fields)
        }
        _ => None,
    }
}

pub(crate) fn direction_name(direction: SortDirection) -> &'static str {
    match direction {
        SortDirection::Asc => "asc",
        SortDirection::Desc => "desc",
    }
}

pub(crate) fn wire_sort_field(entry: &SortField) -> Value {
    let mut field = Map::with_capacity(3);
    field.insert("field", Value::from(entry.field.as_str()));
    field.insert("direction", Value::from(direction_name(entry.direction)));
    if let Some(mode) = entry.mode {
        let mode = match mode {
            narsil::SortMode::Min => "min",
            narsil::SortMode::Max => "max",
            narsil::SortMode::Avg => "avg",
            narsil::SortMode::Median => "median",
        };
        field.insert("mode", Value::from(mode));
    }
    Value::Object(field)
}

fn strings(values: &[String]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::from(value.as_str()))
            .collect(),
    )
}

struct Merged {
    entry: ListEntryWire,
    key: Option<Vec<Value>>,
}

pub(crate) async fn list_cluster(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    params: &ListParams,
    sort: &[SortField],
) -> ClusterResult<ListResult> {
    let table = routable_allocation(deps, index_name).await?;
    let start_time = Instant::now();
    let limit = clamp_list_limit(params.limit)?;
    let signature = sort_signature(Some(sort))?;
    let binding = listing_binding(params.filters.as_ref());
    if let Some(cursor) = &params.cursor {
        decode_cursor(cursor, signature.as_deref(), false, &binding)?;
    }
    let sort_field_names: Option<Vec<String>> =
        (!sort.is_empty()).then(|| sort.iter().map(|entry| entry.field.clone()).collect());
    let directions: Vec<SortDirection> = sort.iter().map(|entry| entry.direction).collect();
    let settings = deps.vector_reads.settings_of(index_name, &table).await?;
    let projection = resolve_projection(params.document.as_ref(), &settings);

    let mut payload = Map::with_capacity(8);
    payload.insert("indexName", Value::from(index_name));
    payload.insert("partitionIds", Value::Array(Vec::new()));
    payload.insert(
        "cursor",
        params
            .cursor
            .as_deref()
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    payload.insert("limit", Value::from(limit));
    payload.insert("filters", params.filters.clone().unwrap_or(Value::Null));
    payload.insert(
        "sort",
        match &sort_field_names {
            Some(_) => Value::Array(sort.iter().map(wire_sort_field).collect()),
            None => Value::Null,
        },
    );
    payload.insert(
        "fields",
        wire_fields_for(&projection, sort_field_names.as_deref().unwrap_or_default())
            .map(|fields| strings(&fields))
            .unwrap_or(Value::Null),
    );
    if !keeps_any_vector_field(&projection, &settings) {
        payload.insert("vectors", Value::Bool(false));
    }

    let scatter_deps = Arc::clone(deps);
    let index: Arc<str> = Arc::from(index_name);
    let payload = Arc::new(payload);
    let gathered = gather_from_every_partition(
        deps,
        &table,
        index_name,
        move |group| {
            let deps = Arc::clone(&scatter_deps);
            let index = Arc::clone(&index);
            let mut payload = Map::clone(&payload);
            async move {
                payload.insert(
                    "partitionIds",
                    Value::Array(
                        group
                            .partition_ids
                            .iter()
                            .map(|id| Value::from(*id))
                            .collect(),
                    ),
                );
                let message = request(&deps, message_types::QUERY_LIST, &payload)?;
                send_read_request(
                    &deps,
                    &group.node_id,
                    &message,
                    &index,
                    validate_list_result_payload,
                    true,
                )
                .await
            }
        },
        true,
    )
    .await
    .map_err(|failure| failure.error)?;

    let mut total: u64 = 0;
    let mut node_reports_more = false;
    let mut merged: Vec<Merged> = Vec::new();
    for result in gathered {
        total = total.saturating_add(result.total);
        node_reports_more = node_reports_more || result.has_more;
        for entry in result.entries {
            let key = sort_field_names.as_ref().map(|_| {
                entry
                    .sort_values
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(comparable_sort_value)
                    .collect()
            });
            merged.push(Merged { entry, key });
        }
    }

    let order = match &sort_field_names {
        Some(_) => {
            let keys: Vec<Vec<Value>> = merged
                .iter()
                .map(|item| item.key.clone().unwrap_or_default())
                .collect();
            Some(SortKeyOrder::new(&keys)?)
        }
        None => None,
    };
    let mut positions: Vec<usize> = (0..merged.len()).collect();
    positions.sort_by(|left, right| {
        if let Some(order) = &order {
            let by_key = order.compare(*left, *right, &directions);
            if by_key.is_ne() {
                return by_key;
            }
        }
        merged[*left].entry.doc_id.cmp(&merged[*right].entry.doc_id)
    });

    let has_more = merged.len() > limit || node_reports_more;
    positions.truncate(limit);
    let mut slots: Vec<Option<Merged>> = merged.into_iter().map(Some).collect();
    let page: Vec<Merged> = positions
        .into_iter()
        .filter_map(|position| slots.get_mut(position).and_then(Option::take))
        .collect();

    let cursor = match page.last() {
        Some(last) if has_more => Some(encode_cursor(CoordinatedCursor {
            anchor: last.entry.doc_id.clone(),
            score: None,
            sort_key: sort_field_names
                .as_ref()
                .map(|_| last.key.clone().unwrap_or_default()),
            sort_signature: signature.clone(),
            depth: 0,
            binding,
        })),
        _ => None,
    };

    let documents = page
        .into_iter()
        .map(|item| ListedDocument {
            id: item.entry.doc_id,
            document: match projection {
                ResolvedProjection::Nothing => Map::new(),
                _ => apply_projection(item.entry.document, &projection),
            },
        })
        .collect();

    Ok(ListResult {
        documents,
        cursor,
        total,
        elapsed: start_time.elapsed(),
    })
}
