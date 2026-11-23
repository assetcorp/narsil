use std::sync::Arc;

use narsil::{DocumentProjection, ListParams, Map, SortField, Value};

use super::QueryDeps;
use super::payload::{
    answer, index_name, invalid, partition_ids, positive_integer, request_fields, string_field,
    string_list,
};
use super::projection::kept_fields;
use super::refusal::{ServedRead, refuse_unserved_read};
use super::sort::{sort_fields, wire_sort_values};
use crate::constants::{
    MAX_FIELD_NAME_LENGTH, MAX_FIELDS_LIST, MAX_LIST_CURSOR_LENGTH, MAX_QUERY_LIMIT,
};
use crate::data::blocking::off_executor;
use crate::error::{ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

const LIST_PAYLOAD: &str = "ListPayload";

struct ListRequest {
    index_name: String,
    partition_ids: Vec<u32>,
    params: ListParams,
    sort: Vec<SortField>,
    fields: Option<Vec<String>>,
}

fn listed_fields(fields: Option<&Vec<String>>, sort: &[SortField]) -> Option<Vec<String>> {
    let fields = fields?;
    if fields.is_empty() || sort.is_empty() {
        return Some(fields.clone());
    }
    let mut listed = fields.clone();
    for entry in sort {
        if !listed.contains(&entry.field) {
            listed.push(entry.field.clone());
        }
    }
    Some(listed)
}

fn list_request(message: &TransportMessage) -> ClusterResult<ListRequest> {
    let fields = request_fields(message, LIST_PAYLOAD)?;
    let index_name = index_name(&fields, LIST_PAYLOAD)?;
    let partition_ids = partition_ids(&fields)?;
    let cursor = match fields.get("cursor") {
        None | Some(Value::Null) => None,
        cursor => Some(string_field(
            cursor,
            "cursor",
            MAX_LIST_CURSOR_LENGTH,
            codes::CONFIG_INVALID,
        )?),
    };
    let limit = positive_integer(
        fields.get("limit"),
        "limit",
        MAX_QUERY_LIMIT,
        codes::CONFIG_INVALID,
    )?;
    let filters = match fields.get("filters") {
        None | Some(Value::Null) => None,
        Some(filters) => Some(filters.clone()),
    };
    let sort = sort_fields(fields.get("sort"), LIST_PAYLOAD, "sort")?;
    let requested_fields = match fields.get("fields") {
        None | Some(Value::Null) => None,
        listed => Some(string_list(
            listed,
            "fields",
            MAX_FIELDS_LIST,
            MAX_FIELD_NAME_LENGTH,
            codes::SEARCH_INVALID_FIELD,
        )?),
    };
    let vectors = match fields.get("vectors") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(vectors)) => *vectors,
        Some(_) => {
            return Err(invalid(
                codes::CONFIG_INVALID,
                "Invalid ListPayload: \"vectors\" must be a boolean, or null",
            ));
        }
    };
    let document = DocumentProjection::Fields {
        include: listed_fields(requested_fields.as_ref(), &sort),
        exclude: None,
        vectors: Some(vectors),
    };
    Ok(ListRequest {
        index_name,
        partition_ids,
        params: ListParams {
            cursor,
            limit: Some(limit as usize),
            filters,
            document: Some(document),
        },
        sort,
        fields: requested_fields,
    })
}

pub(super) async fn answer_list(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let request = list_request(message)?;
    refuse_unserved_read(
        &deps.view,
        deps.node_id,
        &request.index_name,
        &request.partition_ids,
        ServedRead::Query,
    )
    .await?;
    let copies = Arc::clone(&deps.copies);
    let (listed, request) = off_executor(move || {
        let listed = copies.list_partitions(
            &request.index_name,
            &request.params,
            &request.sort,
            &request.partition_ids,
        );
        (listed, request)
    })
    .await?;
    let listed = listed?;
    let trims = request
        .fields
        .as_ref()
        .is_some_and(|fields| !fields.is_empty() && !request.sort.is_empty());
    let mut entries = Vec::with_capacity(listed.documents.len());
    for document in listed.documents {
        let mut entry = Map::with_capacity(3);
        let sort_values = match request.sort.is_empty() {
            true => Value::Null,
            false => wire_sort_values(Some(&document.document), &request.sort)?,
        };
        let stored = match (trims, request.fields.as_deref()) {
            (true, Some(fields)) => kept_fields(&document.document, fields),
            _ => document.document,
        };
        entry.insert("docId", Value::String(document.id));
        entry.insert("document", Value::Object(stored));
        entry.insert("sortValues", sort_values);
        entries.push(Value::Object(entry));
    }
    let mut payload = Map::with_capacity(3);
    payload.insert("entries", Value::Array(entries));
    payload.insert("total", Value::from(listed.total));
    payload.insert("hasMore", Value::Bool(listed.cursor.is_some()));
    answer(
        message,
        message_types::QUERY_LIST_RESULT,
        deps.node_id,
        payload,
    )
}
