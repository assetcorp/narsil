use narsil::{Map, Value, encode_msgpack};

use super::fields::{Field, fields_of};
use super::{index_uuid, invalid_entry, members};
use crate::constants::MAX_FORWARD_BATCH_OPERATIONS;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::wire::{write_bool, write_map_header, write_nil, write_str, write_uint};

const FORWARD_PAYLOAD: &str = "ForwardPayload";
const FORWARD_BATCH_PAYLOAD: &str = "ForwardBatchPayload";
const OPERATION_FIELDS: [&str; 9] = [
    "documentId",
    "operation",
    "document",
    "updateFields",
    "ifSeqNo",
    "ifPrimaryTerm",
    "abandonedSeqNo",
    "abandonedPrimaryTerm",
    "compensationSeqNo",
];
const CONDITION_FIELD_NAMES: [&str; 5] = [
    "ifSeqNo",
    "ifPrimaryTerm",
    "abandonedSeqNo",
    "abandonedPrimaryTerm",
    "compensationSeqNo",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForwardKind {
    Insert,
    Remove,
    Update,
}

impl ForwardKind {
    pub(crate) fn wording(self) -> &'static str {
        match self {
            ForwardKind::Insert => "insert",
            ForwardKind::Remove => "remove",
            ForwardKind::Update => "update",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WriteCondition {
    pub(crate) if_seq_no: u64,
    pub(crate) if_primary_term: u64,
    pub(crate) abandoned_seq_no: u64,
    pub(crate) abandoned_primary_term: u64,
    pub(crate) compensation_seq_no: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AbandonedWrite {
    pub(crate) seq_no: u64,
    pub(crate) primary_term: u64,
    pub(crate) compensation_seq_no: u64,
    pub(crate) previous_seq_no: u64,
    pub(crate) previous_primary_term: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct ForwardOperation {
    pub(crate) document_id: String,
    pub(crate) kind: ForwardKind,
    pub(crate) document: Option<Vec<u8>>,
    pub(crate) update_fields: Option<Map>,
    pub(crate) condition: Result<Option<WriteCondition>, ClusterError>,
}

pub(crate) struct ForwardRequest {
    pub(crate) index_name: String,
    pub(crate) index_uuid: Option<String>,
    pub(crate) operations: Vec<ForwardOperation>,
}

fn condition_of(
    fields: &[Field<'_>; 9],
    kind: ForwardKind,
    document_id: &str,
) -> Result<Option<WriteCondition>, ClusterError> {
    let given: Vec<(&str, Field<'_>)> = CONDITION_FIELD_NAMES
        .iter()
        .zip(&fields[4..])
        .filter(|(_, field)| field.present().is_some())
        .map(|(name, field)| (*name, *field))
        .collect();
    if given.is_empty() {
        return Ok(None);
    }
    let present = || Value::Array(given.iter().map(|(name, _)| Value::from(*name)).collect());
    if given.len() != CONDITION_FIELD_NAMES.len() || kind == ForwardKind::Insert {
        let message = if kind == ForwardKind::Insert {
            format!("A forwarded insert of document '{document_id}' cannot carry a write condition")
        } else {
            format!(
                "A forwarded {} of document '{document_id}' must carry all five condition fields or none",
                kind.wording()
            )
        };
        return Err(ClusterError::new(codes::REPLICATION_ENTRY_INVALID, message)
            .with_detail("documentId", Value::from(document_id))
            .with_detail("operation", Value::from(kind.wording()))
            .with_detail("present", present()));
    }
    let numbers: Option<Vec<u64>> = given.iter().map(|(_, field)| field.count()).collect();
    let Some(
        [
            if_seq_no,
            if_primary_term,
            abandoned_seq_no,
            abandoned_primary_term,
            compensation_seq_no,
        ],
    ) = numbers.and_then(|numbers| <[u64; 5]>::try_from(numbers).ok())
    else {
        return Err(ClusterError::new(
            codes::REPLICATION_ENTRY_INVALID,
            format!(
                "The condition fields of a forwarded {} of document '{document_id}' must be non-negative integers",
                kind.wording()
            ),
        )
        .with_detail("documentId", Value::from(document_id))
        .with_detail("operation", Value::from(kind.wording())));
    };
    Ok(Some(WriteCondition {
        if_seq_no,
        if_primary_term,
        abandoned_seq_no,
        abandoned_primary_term,
        compensation_seq_no,
    }))
}

fn operation_of(fields: [Field<'_>; 9], label: &str) -> ClusterResult<ForwardOperation> {
    let document_id = fields[0]
        .filled_text()
        .ok_or_else(|| invalid_entry(label, "\"documentId\" must be a non-empty string"))?;
    let kind = match fields[1].text() {
        Some("insert") => ForwardKind::Insert,
        Some("remove") => ForwardKind::Remove,
        Some("update") => ForwardKind::Update,
        _ => {
            return Err(invalid_entry(
                label,
                "\"operation\" must be \"insert\", \"remove\", or \"update\"",
            ));
        }
    };
    let document = fields[2]
        .optional(Field::binary)
        .ok_or_else(|| invalid_entry(label, "\"document\" must be binary or absent"))?
        .map(<[u8]>::to_vec);
    let update_fields = fields[3]
        .optional(Field::map)
        .ok_or_else(|| invalid_entry(label, "\"updateFields\" must be a map or absent"))?;
    if kind == ForwardKind::Insert && document.is_none() {
        return Err(invalid_entry(label, "an insert requires a document"));
    }
    if kind == ForwardKind::Update && document.is_none() && update_fields.is_none() {
        return Err(invalid_entry(
            label,
            "an update requires a document or updateFields",
        ));
    }
    let condition = condition_of(&fields, kind, document_id);
    Ok(ForwardOperation {
        document_id: document_id.to_string(),
        kind,
        document,
        update_fields,
        condition,
    })
}

fn index_name_of(field: Field<'_>, payload_name: &str) -> ClusterResult<String> {
    field
        .filled_text()
        .map(str::to_string)
        .ok_or_else(|| invalid_entry(payload_name, "\"indexName\" must be a non-empty string"))
}

pub(crate) fn decode_forward(payload: &[u8]) -> ClusterResult<ForwardRequest> {
    let fields = fields_of(
        payload,
        [
            "indexName",
            "indexUuid",
            "documentId",
            "operation",
            "document",
            "updateFields",
            "ifSeqNo",
            "ifPrimaryTerm",
            "abandonedSeqNo",
            "abandonedPrimaryTerm",
            "compensationSeqNo",
        ],
    )
    .ok_or_else(|| invalid_entry(FORWARD_PAYLOAD, "expected an object"))?;
    let [index_name, uuid, rest @ ..] = fields;
    let index_name = index_name_of(index_name, FORWARD_PAYLOAD)?;
    let operation = operation_of(rest, FORWARD_PAYLOAD)?;
    if let Err(error) = &operation.condition {
        return Err(error.clone());
    }
    Ok(ForwardRequest {
        index_name,
        index_uuid: index_uuid(uuid, FORWARD_PAYLOAD)?,
        operations: vec![operation],
    })
}

pub(crate) fn decode_forward_batch(payload: &[u8]) -> ClusterResult<ForwardRequest> {
    let [index_name, operations, uuid] = members(
        payload,
        ["indexName", "operations", "indexUuid"],
        FORWARD_BATCH_PAYLOAD,
    )?;
    let index_name = index_name_of(index_name, FORWARD_BATCH_PAYLOAD)?;
    let items = operations
        .items()
        .ok_or_else(|| invalid_entry(FORWARD_BATCH_PAYLOAD, "\"operations\" must be an array"))?;
    if items.len() == 0 || items.len() > MAX_FORWARD_BATCH_OPERATIONS {
        return Err(invalid_entry(
            FORWARD_BATCH_PAYLOAD,
            &format!(
                "\"operations\" must hold from 1 to {MAX_FORWARD_BATCH_OPERATIONS} operations"
            ),
        ));
    }
    let mut decoded = Vec::with_capacity(items.len());
    for (position, raw) in items.enumerate() {
        let label = format!("{FORWARD_BATCH_PAYLOAD} \"operations[{position}]\"");
        let fields = fields_of(raw, OPERATION_FIELDS).ok_or_else(|| {
            invalid_entry(
                FORWARD_BATCH_PAYLOAD,
                &format!("\"operations[{position}]\" must be an object"),
            )
        })?;
        decoded.push(operation_of(fields, &label)?);
    }
    Ok(ForwardRequest {
        index_name,
        index_uuid: index_uuid(uuid, FORWARD_BATCH_PAYLOAD)?,
        operations: decoded,
    })
}

fn write_abandoned(out: &mut Vec<u8>, abandoned: &AbandonedWrite) {
    write_map_header(out, 5);
    write_str(out, "seqNo");
    write_uint(out, abandoned.seq_no);
    write_str(out, "primaryTerm");
    write_uint(out, abandoned.primary_term);
    write_str(out, "compensationSeqNo");
    write_uint(out, abandoned.compensation_seq_no);
    write_str(out, "previousSeqNo");
    write_uint(out, abandoned.previous_seq_no);
    write_str(out, "previousPrimaryTerm");
    write_uint(out, abandoned.previous_primary_term);
}

fn write_value(out: &mut Vec<u8>, value: &Value) {
    match encode_msgpack(value) {
        Ok(bytes) => out.extend_from_slice(&bytes),
        Err(_) => write_nil(out),
    }
}

pub(crate) struct WriteFailure {
    pub(crate) error: ClusterError,
    pub(crate) abandoned: Option<AbandonedWrite>,
}

impl From<ClusterError> for WriteFailure {
    fn from(error: ClusterError) -> WriteFailure {
        WriteFailure {
            error,
            abandoned: None,
        }
    }
}

pub(crate) fn encode_forward_refusal(failure: &WriteFailure) -> Vec<u8> {
    let error = &failure.error;
    let keys =
        3 + usize::from(!error.details().is_empty()) + usize::from(failure.abandoned.is_some());
    let mut out = Vec::new();
    write_map_header(&mut out, keys);
    write_str(&mut out, "error");
    write_bool(&mut out, true);
    write_str(&mut out, "code");
    write_str(&mut out, error.code());
    write_str(&mut out, "message");
    write_str(&mut out, error.message());
    if !error.details().is_empty() {
        write_str(&mut out, "details");
        write_value(&mut out, &Value::Object(error.details().clone()));
    }
    if let Some(abandoned) = &failure.abandoned {
        write_str(&mut out, "abandonedWrite");
        write_abandoned(&mut out, abandoned);
    }
    out
}

pub(crate) fn encode_forward_answer(document_id: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(document_id.len() + 32);
    write_map_header(&mut out, 2);
    write_str(&mut out, "documentId");
    write_str(&mut out, document_id);
    write_str(&mut out, "success");
    write_bool(&mut out, true);
    out
}

pub(crate) fn encode_forward_batch_answer(
    results: &[(String, Result<(), WriteFailure>)],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(results.len() * 48 + 16);
    write_map_header(&mut out, 1);
    write_str(&mut out, "results");
    crate::wire::write_array_header(&mut out, results.len());
    for (document_id, outcome) in results {
        match outcome {
            Ok(()) => {
                write_map_header(&mut out, 4);
                write_str(&mut out, "documentId");
                write_str(&mut out, document_id);
                write_str(&mut out, "success");
                write_bool(&mut out, true);
                write_str(&mut out, "errorCode");
                write_nil(&mut out);
                write_str(&mut out, "errorMessage");
                write_nil(&mut out);
            }
            Err(failure) => {
                write_map_header(&mut out, 5 + usize::from(failure.abandoned.is_some()));
                write_str(&mut out, "documentId");
                write_str(&mut out, document_id);
                write_str(&mut out, "success");
                write_bool(&mut out, false);
                write_str(&mut out, "errorCode");
                write_str(&mut out, failure.error.code());
                write_str(&mut out, "errorMessage");
                write_str(&mut out, failure.error.message());
                write_str(&mut out, "errorDetails");
                if failure.error.details().is_empty() {
                    write_nil(&mut out);
                } else {
                    write_value(&mut out, &Value::Object(failure.error.details().clone()));
                }
                if let Some(abandoned) = &failure.abandoned {
                    write_str(&mut out, "abandonedWrite");
                    write_abandoned(&mut out, abandoned);
                }
            }
        }
    }
    out
}
