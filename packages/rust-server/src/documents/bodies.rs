use narsil::{DocumentProjection, ErrorCode, IndexConfig, Map, Value};

pub(crate) use super::index_config::with_given_values;
use super::index_config::{index_config_of, refusal};
use crate::errors::{Outcome, ServerError};
use crate::script_values::{displayed_name, script_text, script_type_name};
use crate::search::projection;

pub(crate) fn field<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    body.as_object().and_then(|body| body.get(key))
}

pub(crate) fn take_field(body: &mut Value, key: &str) -> Option<Value> {
    body.as_object_mut().and_then(|body| body.remove(key))
}

pub(crate) fn create_index_request(body: &Value) -> Outcome<(String, IndexConfig)> {
    let name = match field(body, "name") {
        Some(Value::String(name)) if !name.is_empty() => name.clone(),
        _ => {
            return Err(ServerError::invalid(
                "Field \"name\" is required and must be a non-empty string",
            ));
        }
    };
    let Some(Value::Object(config)) = field(body, "config") else {
        return Err(ServerError::invalid(
            "Field \"config\" is required and must be an object",
        ));
    };
    Ok((name, index_config_of(config)?))
}

pub(crate) fn document_of(body: &mut Value) -> Outcome<Map> {
    match take_field(body, "document") {
        Some(Value::Object(document)) => Ok(document),
        _ => Err(ServerError::invalid(
            "Field \"document\" is required and must be an object",
        )),
    }
}

fn received_id_type(id: &Value) -> &'static str {
    match id {
        Value::Null => "null",
        Value::Array(_) => "array",
        other => script_type_name(other),
    }
}

pub(crate) fn id_refusal(id: &Value) -> ServerError {
    refusal(
        ErrorCode::DOC_VALIDATION_FAILED,
        "Document ID must be a string",
        vec![("received", Value::String(received_id_type(id).to_string()))],
    )
}

pub(crate) enum ChosenId {
    Absent,
    Given(String),
    Refused(ServerError),
}

fn mismatched_id(given: &Value, document: &Map) -> Option<ServerError> {
    let Some(Value::String(embedded)) = document.get("id") else {
        return None;
    };
    if embedded.is_empty() {
        return None;
    }
    let doc_id = script_text(given);
    let mut details = Map::with_capacity(2);
    details.insert("docId", given.clone());
    details.insert("documentId", Value::String(embedded.clone()));
    Some(
        ServerError::coded(
            ErrorCode::DOC_VALIDATION_FAILED.as_str(),
            format!(
                "The call names document id \"{doc_id}\" while the document's own id field is \"{embedded}\", so the stored document would contradict the key that it is stored under"
            ),
        )
        .with_details(details),
    )
}

pub(crate) fn insert_id_of(body: &Value, document: &Map) -> ChosenId {
    let Some(given) = field(body, "id") else {
        return ChosenId::Absent;
    };
    if let Value::String(id) = given {
        return ChosenId::Given(id.clone());
    }
    if let Some(refusal) = mismatched_id(given, document) {
        return ChosenId::Refused(refusal);
    }
    match given {
        Value::Null => ChosenId::Absent,
        other => ChosenId::Refused(id_refusal(other)),
    }
}

pub(crate) fn multi_get_projection(body: &Value) -> Outcome<Option<DocumentProjection>> {
    field(body, "document")
        .filter(|document| !document.is_null())
        .map(projection)
        .transpose()
}

pub(crate) fn read_projection(vectors: Option<&str>) -> Outcome<Option<DocumentProjection>> {
    let vectors = match vectors {
        None | Some("") => return Ok(None),
        Some("true") => true,
        Some("false") => false,
        Some(other) => {
            let mut details = Map::new();
            details.insert("option", Value::String("vectors".to_string()));
            details.insert("received", Value::String(displayed_name(other).to_string()));
            return Err(ServerError::coded(
                ErrorCode::SEARCH_INVALID_FIELD.as_str(),
                "Query parameter \"vectors\" must be true or false",
            )
            .with_details(details));
        }
    };
    Ok(Some(DocumentProjection::Fields {
        include: None,
        exclude: None,
        vectors: Some(vectors),
    }))
}

pub(crate) fn multi_get_ids(body: &Value, max_fetch_documents: u64) -> Outcome<Vec<String>> {
    let Some(Value::Array(ids)) = field(body, "docIds") else {
        return Err(ServerError::invalid(
            "Field \"docIds\" is required and must be an array of strings",
        ));
    };
    let count = ids.len() as u64;
    if count > max_fetch_documents {
        let mut details = Map::new();
        details.insert("count", Value::Number(count as f64));
        details.insert("limit", Value::Number(max_fetch_documents as f64));
        return Err(ServerError::invalid(format!(
            "Field \"docIds\" exceeds the maximum of {max_fetch_documents} ids per request"
        ))
        .with_details(details));
    }
    let mut wanted: Vec<String> = Vec::with_capacity(ids.len());
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    for id in ids {
        if let Value::String(id) = id
            && seen.insert(id.as_str())
        {
            wanted.push(id.clone());
        }
    }
    Ok(wanted)
}
