use std::sync::Arc;

use narsil::{DocumentProjection, Map, Value};

use super::QueryDeps;
use super::payload::{answer, index_name, invalid, request_fields, string_field, string_list};
use super::projection::{kept_fields, without_paths};
use super::refusal::{ServedRead, refuse_unserved_read};
use crate::constants::{
    MAX_DOC_ID_LENGTH, MAX_FETCH_DOCUMENT_IDS, MAX_FIELD_NAME_LENGTH, MAX_FIELDS_LIST,
    MAX_PARTITION_COUNT, MAX_SEARCH_CONTEXT_ID_LENGTH,
};
use crate::data::blocking::off_executor;
use crate::error::{ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

const FETCH_PAYLOAD: &str = "FetchPayload";

struct FetchRequest {
    index_name: String,
    document_ids: Vec<(String, u32)>,
    projection: DocumentProjection,
    include: Option<Vec<String>>,
    vectors: bool,
    context_id: Option<String>,
    release_context: bool,
}

fn document_id(value: &Value, at: usize) -> ClusterResult<(String, u32)> {
    let label = format!("documentIds[{at}]");
    let Value::Object(entry) = value else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid FetchPayload: \"{label}\" must be an object"),
        ));
    };
    let doc_id = string_field(
        entry.get("docId"),
        &format!("{label}.docId"),
        MAX_DOC_ID_LENGTH,
        codes::CONFIG_INVALID,
    )?;
    let partition_id = match entry.get("partitionId") {
        Some(Value::Number(number))
            if number.fract() == 0.0 && (0.0..MAX_PARTITION_COUNT).contains(number) =>
        {
            *number as u32
        }
        _ => {
            return Err(invalid(
                codes::CONFIG_INVALID,
                format!(
                    "Invalid payload: \"{label}.partitionId\" must be between 0 and {}",
                    MAX_PARTITION_COUNT - 1.0
                ),
            ));
        }
    };
    Ok((doc_id, partition_id))
}

fn fetch_request(message: &TransportMessage) -> ClusterResult<FetchRequest> {
    let fields = request_fields(message, FETCH_PAYLOAD)?;
    let index_name = index_name(&fields, FETCH_PAYLOAD)?;
    let Some(Value::Array(items)) = fields.get("documentIds") else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            "Invalid FetchPayload: \"documentIds\" must be an array",
        ));
    };
    if items.len() > MAX_FETCH_DOCUMENT_IDS {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!(
                "Invalid FetchPayload: \"documentIds\" exceeds maximum length of {MAX_FETCH_DOCUMENT_IDS}"
            ),
        )
        .with_detail("length", Value::from(items.len()))
        .with_detail("limit", Value::from(MAX_FETCH_DOCUMENT_IDS)));
    }
    let document_ids = items
        .iter()
        .enumerate()
        .map(|(at, item)| document_id(item, at))
        .collect::<ClusterResult<Vec<_>>>()?;
    let include = match fields.get("fields") {
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
                "Invalid FetchPayload: \"vectors\" must be a boolean, or null",
            ));
        }
    };
    let context_id = match fields.get("contextId") {
        None | Some(Value::Null) => None,
        context => Some(string_field(
            context,
            "contextId",
            MAX_SEARCH_CONTEXT_ID_LENGTH,
            codes::CONFIG_INVALID,
        )?),
    };
    let release_context = match fields.get("releaseContext") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(release)) => *release,
        Some(_) => {
            return Err(invalid(
                codes::CONFIG_INVALID,
                "Invalid FetchPayload: \"releaseContext\" must be a boolean, or null",
            ));
        }
    };
    Ok(FetchRequest {
        index_name,
        document_ids,
        projection: DocumentProjection::Fields {
            include: include.clone(),
            exclude: None,
            vectors: Some(vectors),
        },
        include,
        vectors,
        context_id,
        release_context,
    })
}

fn context_documents(
    deps: &QueryDeps<'_>,
    request: &FetchRequest,
    context_id: &str,
) -> ClusterResult<Vec<(String, Map)>> {
    let ranked = deps.contexts.read(context_id);
    if request.release_context {
        deps.contexts.release(context_id);
    }
    let Some(ranked) = ranked else {
        if request.document_ids.is_empty() {
            return Ok(Vec::new());
        }
        return Err(missing_context(deps.node_id, context_id));
    };
    let mut documents = Vec::with_capacity(request.document_ids.len());
    for (doc_id, _) in &request.document_ids {
        let Some(stored) = ranked.documents.get(doc_id) else {
            continue;
        };
        let stored = match request.vectors {
            true => stored.clone(),
            false => without_paths(stored.clone(), &ranked.vector_paths),
        };
        let document = match &request.include {
            Some(include) => kept_fields(&stored, include),
            None => stored,
        };
        documents.push((doc_id.clone(), document));
    }
    Ok(documents)
}

fn missing_context(node_id: &str, context_id: &str) -> crate::error::ClusterError {
    invalid(
        codes::SEARCH_CONTEXT_MISSING,
        format!(
            "Node '{node_id}' holds no search context '{context_id}', because it expired, the node restarted, or the coordinating node released it"
        ),
    )
    .with_detail("contextId", Value::String(context_id.to_string()))
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

pub(super) async fn answer_fetch(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let request = fetch_request(message)?;
    let documents = match &request.context_id {
        Some(context_id) => context_documents(deps, &request, context_id)?,
        None => {
            let mut partition_ids: Vec<u32> = request
                .document_ids
                .iter()
                .map(|(_, partition_id)| *partition_id)
                .collect();
            partition_ids.sort_unstable();
            partition_ids.dedup();
            refuse_unserved_read(
                &deps.view,
                deps.node_id,
                &request.index_name,
                &partition_ids,
                ServedRead::Query,
            )
            .await?;
            let copies = Arc::clone(&deps.copies);
            off_executor(move || {
                copies.fetch_documents(
                    &request.index_name,
                    &request.document_ids,
                    &request.projection,
                )
            })
            .await??
        }
    };
    let fetched = documents
        .into_iter()
        .map(|(doc_id, document)| {
            let mut entry = Map::with_capacity(3);
            entry.insert("docId", Value::String(doc_id));
            entry.insert("document", Value::Object(document));
            entry.insert("highlights", Value::Null);
            Value::Object(entry)
        })
        .collect();
    let mut payload = Map::with_capacity(1);
    payload.insert("documents", Value::Array(fetched));
    answer(
        message,
        message_types::QUERY_FETCH_RESULT,
        deps.node_id,
        payload,
    )
}
