use narsil::{BatchResult, ErrorCode, Map, Narsil, NarsilError, Value};

use super::bodies::{field, id_refusal, take_field};
use super::script_values::script_type_name;
use crate::errors::{Outcome, ServerError};

const UPDATE_ENTRY_REFUSAL: &str = "Each entry of a batch update must be an object whose docId is a string and whose document is an object";

pub(crate) enum BatchRequest {
    Insert(Vec<Value>),
    Update(Vec<Value>),
    Remove(Vec<Value>),
}

pub(crate) fn batch_request(mut body: Value) -> Outcome<BatchRequest> {
    let action = match field(&body, "action") {
        None | Some(Value::Null) => "insert".to_string(),
        Some(Value::String(action)) => action.clone(),
        Some(_) => String::new(),
    };
    let (key, message) = match action.as_str() {
        "insert" => ("documents", "Batch insert requires a \"documents\" array"),
        "update" => ("updates", "Batch update requires an \"updates\" array"),
        "delete" => ("docIds", "Batch delete requires a \"docIds\" array"),
        _ => {
            return Err(ServerError::invalid(
                "Field \"action\" must be one of \"insert\", \"update\", or \"delete\"",
            ));
        }
    };
    let Some(Value::Array(entries)) = take_field(&mut body, key) else {
        return Err(ServerError::invalid(message));
    };
    Ok(match action.as_str() {
        "update" => BatchRequest::Update(entries),
        "delete" => BatchRequest::Remove(entries),
        _ => BatchRequest::Insert(entries),
    })
}

pub(crate) struct WireFailure {
    doc_id: Value,
    error: ServerError,
}

pub(crate) struct WireBatch {
    succeeded: Vec<String>,
    failed: Vec<WireFailure>,
}

impl WireBatch {
    fn with_refusals(refused: Vec<WireFailure>, result: BatchResult) -> WireBatch {
        let mut failed = refused;
        failed.extend(result.failed.into_iter().map(|failure| WireFailure {
            doc_id: Value::String(failure.doc_id),
            error: ServerError::from(failure.error),
        }));
        WireBatch {
            succeeded: result.succeeded,
            failed,
        }
    }

    pub(crate) fn to_value(&self) -> Value {
        let mut failed = Vec::with_capacity(self.failed.len());
        for failure in &self.failed {
            let mut entry = Map::with_capacity(2);
            entry.insert("docId", failure.doc_id.clone());
            entry.insert("error", error_detail(&failure.error));
            failed.push(Value::Object(entry));
        }
        let mut body = Map::with_capacity(2);
        body.insert(
            "succeeded",
            Value::Array(self.succeeded.iter().cloned().map(Value::String).collect()),
        );
        body.insert("failed", Value::Array(failed));
        Value::Object(body)
    }
}

fn error_detail(error: &ServerError) -> Value {
    match error.envelope() {
        Value::Object(mut envelope) => envelope.remove("error").unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn document_refusal(entry: &Value) -> ServerError {
    let received = match entry {
        Value::Array(_) => "a list".to_string(),
        Value::Null => "null".to_string(),
        other => format!("a {}", script_type_name(other)),
    };
    let mut details = Map::new();
    details.insert("received", Value::String(received.clone()));
    ServerError::coded(
        ErrorCode::DOC_VALIDATION_FAILED.as_str(),
        format!("Each document must be an object, while this entry is {received}"),
    )
    .with_details(details)
}

fn insert_all(engine: &Narsil, index: &str, entries: Vec<Value>) -> narsil::Result<WireBatch> {
    let mut documents = Vec::with_capacity(entries.len());
    let mut refused = Vec::new();
    for entry in entries {
        match entry {
            Value::Object(document) => documents.push(document),
            other => refused.push(WireFailure {
                doc_id: Value::String(engine.new_document_id()?),
                error: document_refusal(&other),
            }),
        }
    }
    let result = engine.insert_batch(index, documents)?;
    Ok(WireBatch::with_refusals(refused, result))
}

fn update_all(engine: &Narsil, index: &str, entries: Vec<Value>) -> narsil::Result<WireBatch> {
    let mut updates = Vec::with_capacity(entries.len());
    let mut refused = Vec::new();
    for mut entry in entries {
        let doc_id = match take_field(&mut entry, "docId") {
            Some(Value::String(doc_id)) => Some(doc_id),
            _ => None,
        };
        let document = match take_field(&mut entry, "document") {
            Some(Value::Object(document)) => Some(document),
            _ => None,
        };
        match (doc_id, document) {
            (Some(doc_id), Some(document)) => updates.push((doc_id, document)),
            (doc_id, _) => refused.push(WireFailure {
                doc_id: Value::String(doc_id.unwrap_or_default()),
                error: ServerError::coded(
                    ErrorCode::DOC_VALIDATION_FAILED.as_str(),
                    UPDATE_ENTRY_REFUSAL,
                ),
            }),
        }
    }
    let result = engine.update_batch(index, updates)?;
    Ok(WireBatch::with_refusals(refused, result))
}

fn remove_all(engine: &Narsil, index: &str, entries: Vec<Value>) -> narsil::Result<WireBatch> {
    let mut doc_ids = Vec::with_capacity(entries.len());
    let mut refused = Vec::new();
    for entry in entries {
        match entry {
            Value::String(doc_id) => doc_ids.push(doc_id),
            other => refused.push(WireFailure {
                error: id_refusal(&other),
                doc_id: other,
            }),
        }
    }
    let result = engine.remove_batch(index, doc_ids)?;
    Ok(WireBatch::with_refusals(refused, result))
}

pub(crate) fn run_batch(
    engine: &Narsil,
    index: &str,
    request: BatchRequest,
) -> Result<WireBatch, NarsilError> {
    match request {
        BatchRequest::Insert(entries) => insert_all(engine, index, entries),
        BatchRequest::Update(entries) => update_all(engine, index, entries),
        BatchRequest::Remove(entries) => remove_all(engine, index, entries),
    }
}
