use narsil::{Map, Value, decode_msgpack};

use super::forward::{AbandonedWrite, ForwardKind, WriteCondition, WriteFailure};
use crate::constants::MAX_SAFE_INTEGER;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{CARRIER_ERROR_TYPE, ERROR_TYPE_SUFFIX, TransportMessage};
use crate::wire::{
    write_array_header, write_bin, write_map_header, write_nil, write_str, write_uint,
};

pub(crate) struct OutgoingOperation<'a> {
    pub(crate) document_id: &'a str,
    pub(crate) kind: ForwardKind,
    pub(crate) document: Option<&'a [u8]>,
    pub(crate) condition: Option<WriteCondition>,
}

fn write_operation_fields(out: &mut Vec<u8>, operation: &OutgoingOperation<'_>) {
    write_str(out, "documentId");
    write_str(out, operation.document_id);
    write_str(out, "operation");
    write_str(out, operation.kind.wording());
    write_str(out, "document");
    match operation.document {
        Some(document) => write_bin(out, document),
        None => write_nil(out),
    }
    write_str(out, "updateFields");
    write_nil(out);
    if let Some(condition) = &operation.condition {
        for (name, number) in [
            ("ifSeqNo", condition.if_seq_no),
            ("ifPrimaryTerm", condition.if_primary_term),
            ("abandonedSeqNo", condition.abandoned_seq_no),
            ("abandonedPrimaryTerm", condition.abandoned_primary_term),
            ("compensationSeqNo", condition.compensation_seq_no),
        ] {
            write_str(out, name);
            write_uint(out, number);
        }
    }
}

fn operation_field_count(operation: &OutgoingOperation<'_>) -> usize {
    4 + if operation.condition.is_some() { 5 } else { 0 }
}

pub(crate) fn encode_forward_request(
    index_name: &str,
    index_uuid: Option<&str>,
    operation: &OutgoingOperation<'_>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(operation.document.map_or(0, <[u8]>::len) + 128);
    let count = 1 + operation_field_count(operation) + usize::from(index_uuid.is_some());
    write_map_header(&mut out, count);
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_operation_fields(&mut out, operation);
    if let Some(uuid) = index_uuid {
        write_str(&mut out, "indexUuid");
        write_str(&mut out, uuid);
    }
    out
}

pub(crate) fn encode_forward_batch_request(
    index_name: &str,
    index_uuid: Option<&str>,
    operations: &[OutgoingOperation<'_>],
) -> Vec<u8> {
    let documents: usize = operations
        .iter()
        .map(|operation| operation.document.map_or(0, <[u8]>::len) + 128)
        .sum();
    let mut out = Vec::with_capacity(documents + 64);
    write_map_header(&mut out, 2 + usize::from(index_uuid.is_some()));
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_str(&mut out, "operations");
    write_array_header(&mut out, operations.len());
    for operation in operations {
        write_map_header(&mut out, operation_field_count(operation));
        write_operation_fields(&mut out, operation);
    }
    if let Some(uuid) = index_uuid {
        write_str(&mut out, "indexUuid");
        write_str(&mut out, uuid);
    }
    out
}

pub(crate) fn encode_fetch_request(index_name: &str, documents: &[(String, u32)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(documents.len() * 48 + 64);
    write_map_header(&mut out, 2);
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_str(&mut out, "documentIds");
    write_array_header(&mut out, documents.len());
    for (document_id, partition_id) in documents {
        write_map_header(&mut out, 2);
        write_str(&mut out, "docId");
        write_str(&mut out, document_id);
        write_str(&mut out, "partitionId");
        write_uint(&mut out, u64::from(*partition_id));
    }
    out
}

fn malformed(what: &str) -> ClusterError {
    ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!("The primary answered with a malformed {what}"),
    )
}

fn sequence_number(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number))
            if number.fract() == 0.0 && *number >= 0.0 && *number <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn abandoned_write_of(value: Option<&Value>) -> Option<AbandonedWrite> {
    let Some(Value::Object(fields)) = value else {
        return None;
    };
    Some(AbandonedWrite {
        seq_no: sequence_number(fields.get("seqNo"))?,
        primary_term: sequence_number(fields.get("primaryTerm"))?,
        compensation_seq_no: sequence_number(fields.get("compensationSeqNo"))?,
        previous_seq_no: sequence_number(fields.get("previousSeqNo"))?,
        previous_primary_term: sequence_number(fields.get("previousPrimaryTerm"))?,
    })
}

fn details_of(value: Option<&Value>) -> Map {
    match value {
        Some(Value::Object(details)) => details.clone(),
        _ => Map::new(),
    }
}

fn refusal_of(
    code: Option<&Value>,
    message: Option<&Value>,
    details: Option<&Value>,
    fallback: String,
) -> ClusterError {
    let code = code
        .and_then(Value::as_str)
        .unwrap_or(codes::QUERY_ROUTING_FAILED);
    let message = message
        .and_then(Value::as_str)
        .map_or(fallback, str::to_string);
    let mut error = ClusterError::new(code, message);
    for (key, value) in details_of(details).iter() {
        error = error.with_detail(key, value.clone());
    }
    error
}

pub(crate) fn decode_answer(
    answer: &TransportMessage,
    index_name: &str,
) -> Result<Map, WriteFailure> {
    if answer.message_type == CARRIER_ERROR_TYPE {
        let failure = answer
            .failure()
            .unwrap_or_else(|| malformed("carrier error"));
        return Err(WriteFailure::from(failure));
    }
    let decoded = match decode_msgpack(&answer.payload) {
        Ok(Value::Object(fields)) => fields,
        _ => return Err(WriteFailure::from(malformed("answer"))),
    };
    let refused = answer.message_type.ends_with(ERROR_TYPE_SUFFIX)
        || decoded.get("error") == Some(&Value::Bool(true));
    if !refused {
        return Ok(decoded);
    }
    Err(WriteFailure {
        error: refusal_of(
            decoded.get("code"),
            decoded.get("message"),
            decoded.get("details"),
            format!("The primary refused a forwarded write for index '{index_name}'"),
        ),
        abandoned: abandoned_write_of(decoded.get("abandonedWrite")),
    })
}

pub(crate) fn forwarded_document_id(decoded: &Map) -> ClusterResult<String> {
    decoded
        .get("documentId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| malformed("forward answer"))
}

pub(crate) type ForwardedResult = (String, Result<(), WriteFailure>);

fn batch_result_of(entry: &Value) -> ClusterResult<ForwardedResult> {
    let Value::Object(fields) = entry else {
        return Err(malformed("forward batch result"));
    };
    let document_id = fields
        .get("documentId")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("forward batch result"))?
        .to_string();
    let outcome = match fields.get("success") {
        Some(Value::Bool(true)) => Ok(()),
        Some(Value::Bool(false)) => Err(WriteFailure {
            error: refusal_of(
                fields.get("errorCode"),
                fields.get("errorMessage"),
                fields.get("errorDetails"),
                format!("The primary refused the forwarded operation '{document_id}'"),
            ),
            abandoned: abandoned_write_of(fields.get("abandonedWrite")),
        }),
        _ => return Err(malformed("forward batch result")),
    };
    Ok((document_id, outcome))
}

pub(crate) fn forwarded_batch_results(decoded: &Map) -> ClusterResult<Vec<ForwardedResult>> {
    let Some(Value::Array(results)) = decoded.get("results") else {
        return Err(malformed("forward batch answer"));
    };
    results.iter().map(batch_result_of).collect()
}

pub(crate) fn fetched_documents(decoded: &Map) -> ClusterResult<Vec<(String, Map)>> {
    let Some(Value::Array(documents)) = decoded.get("documents") else {
        return Err(malformed("fetch answer"));
    };
    documents
        .iter()
        .map(|entry| match entry {
            Value::Object(fields) => match (fields.get("docId"), fields.get("document")) {
                (Some(Value::String(document_id)), Some(Value::Object(document))) => {
                    Ok((document_id.clone(), document.clone()))
                }
                _ => Err(malformed("fetch answer")),
            },
            _ => Err(malformed("fetch answer")),
        })
        .collect()
}
