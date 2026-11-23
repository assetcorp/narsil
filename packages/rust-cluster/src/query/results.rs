use narsil::{Map, Value};

use crate::constants::{
    MAX_COUNT_VALUE, MAX_DOC_ID_LENGTH, MAX_LANGUAGE_NAME_LENGTH, MAX_LIMIT, MAX_SORT_FIELDS,
    MAX_SORT_VALUE_STRING_LENGTH, MAX_SUGGEST_WIRE_LIMIT, MAX_TERM_LENGTH,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::reads::node_messaging::restore_vector_values;

pub(crate) fn invalid(message: String) -> ClusterError {
    ClusterError::new(codes::CONFIG_INVALID, message)
}

fn utf16_length_over(text: &str, limit: usize) -> Option<usize> {
    if text.len() <= limit {
        return None;
    }
    let length = text.encode_utf16().count();
    (length > limit).then_some(length)
}

pub(crate) fn string_field<'a>(
    value: Option<&'a Value>,
    label: &str,
    max_length: usize,
) -> ClusterResult<&'a str> {
    let Some(Value::String(text)) = value else {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" must be a string"
        )));
    };
    if text.is_empty() {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" must be a non-empty string"
        )));
    }
    if let Some(length) = utf16_length_over(text, max_length) {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" exceeds maximum length of {max_length}"
        ))
        .with_detail("length", Value::from(length))
        .with_detail("limit", Value::from(max_length)));
    }
    if text.contains('\0') {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" must not contain null bytes"
        )));
    }
    Ok(text)
}

pub(crate) fn whole_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

pub(crate) fn non_negative_integer(
    value: Option<&Value>,
    label: &str,
    max_value: u64,
) -> ClusterResult<u64> {
    let Some(number) = whole_number(value).filter(|number| *number >= 0.0) else {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" must be a finite non-negative integer"
        )));
    };
    if number > max_value as f64 {
        return Err(invalid(format!(
            "Invalid payload: \"{label}\" exceeds maximum value of {max_value}"
        ))
        .with_detail("value", Value::from(number))
        .with_detail("limit", Value::from(max_value)));
    }
    Ok(number as u64)
}

fn record(value: &Value, message: String) -> ClusterResult<&Map> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(invalid(message)),
    }
}

fn array<'a>(value: Option<&'a Value>, message: &str) -> ClusterResult<&'a [Value]> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        _ => Err(invalid(message.to_string())),
    }
}

fn into_record(value: Value) -> Map {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub(crate) fn validate_fetch_result_payload(decoded: Map) -> ClusterResult<Vec<(String, Map)>> {
    let mut decoded = decoded;
    let Some(Value::Array(documents)) = decoded.remove("documents") else {
        return Err(invalid(
            "Invalid FetchResultPayload: \"documents\" must be an array".to_string(),
        ));
    };
    let mut fetched = Vec::with_capacity(documents.len());
    for (at, entry) in documents.into_iter().enumerate() {
        let Value::Object(mut entry) = entry else {
            return Err(invalid(format!(
                "Invalid FetchResultPayload: \"documents[{at}]\" must be an object"
            )));
        };
        let document_id = string_field(
            entry.get("docId"),
            &format!("documents[{at}].docId"),
            MAX_DOC_ID_LENGTH,
        )?
        .to_string();
        let Some(mut document @ Value::Object(_)) = entry.remove("document") else {
            return Err(invalid(format!(
                "Invalid FetchResultPayload: \"documents[{at}].document\" must be an object"
            )));
        };
        restore_vector_values(&mut document);
        fetched.push((document_id, into_record(document)));
    }
    Ok(fetched)
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PartitionCountEntry {
    pub(crate) partition_id: u32,
    pub(crate) document_count: u64,
    pub(crate) estimated_memory_bytes: u64,
    pub(crate) saved_bytes: Option<u64>,
    pub(crate) vector_saved_bytes: Option<u64>,
    pub(crate) log_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CountResult {
    pub(crate) partitions: Vec<PartitionCountEntry>,
    pub(crate) language: String,
}

fn stored_size(entry: &Map, figure: &str, at: usize) -> ClusterResult<Option<u64>> {
    match entry.get(figure) {
        None | Some(Value::Null) => Ok(None),
        value => non_negative_integer(
            value,
            &format!("partitions[{at}].{figure}"),
            MAX_COUNT_VALUE,
        )
        .map(Some),
    }
}

pub(crate) fn validate_count_result_payload(decoded: Map) -> ClusterResult<CountResult> {
    let entries = array(
        decoded.get("partitions"),
        "Invalid CountResultPayload: \"partitions\" must be an array",
    )?;
    let mut partitions = Vec::with_capacity(entries.len());
    for (at, entry) in entries.iter().enumerate() {
        let entry = record(
            entry,
            format!("Invalid CountResultPayload: \"partitions[{at}]\" must be an object"),
        )?;
        let partition_id = non_negative_integer(
            entry.get("partitionId"),
            &format!("partitions[{at}].partitionId"),
            MAX_COUNT_VALUE,
        )?;
        let document_count = non_negative_integer(
            entry.get("documentCount"),
            &format!("partitions[{at}].documentCount"),
            MAX_COUNT_VALUE,
        )?;
        let estimated_memory_bytes = non_negative_integer(
            entry.get("estimatedMemoryBytes"),
            &format!("partitions[{at}].estimatedMemoryBytes"),
            MAX_COUNT_VALUE,
        )?;
        partitions.push(PartitionCountEntry {
            partition_id: u32::try_from(partition_id).unwrap_or(u32::MAX),
            document_count,
            estimated_memory_bytes,
            saved_bytes: stored_size(entry, "savedBytes", at)?,
            vector_saved_bytes: stored_size(entry, "vectorSavedBytes", at)?,
            log_bytes: stored_size(entry, "logBytes", at)?,
        });
    }
    let language = string_field(
        decoded.get("language"),
        "language",
        MAX_LANGUAGE_NAME_LENGTH,
    )?
    .to_string();
    Ok(CountResult {
        partitions,
        language,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ListEntryWire {
    pub(crate) doc_id: String,
    pub(crate) document: Map,
    pub(crate) sort_values: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ListPage {
    pub(crate) entries: Vec<ListEntryWire>,
    pub(crate) total: u64,
    pub(crate) has_more: bool,
}

fn validate_sort_values(value: Value, label: &str) -> ClusterResult<Vec<Value>> {
    let Value::Array(values) = value else {
        return Err(invalid(format!(
            "Invalid ListResultPayload: \"{label}\" must be an array or null"
        )));
    };
    if values.len() > MAX_SORT_FIELDS {
        return Err(invalid(format!(
            "Invalid ListResultPayload: \"{label}\" exceeds maximum length of {MAX_SORT_FIELDS}"
        )));
    }
    for (at, sort_value) in values.iter().enumerate() {
        match sort_value {
            Value::Null | Value::Number(_) | Value::Bool(_) => {}
            Value::String(text) => {
                if utf16_length_over(text, MAX_SORT_VALUE_STRING_LENGTH).is_some() {
                    return Err(invalid(format!(
                        "Invalid ListResultPayload: \"{label}[{at}]\" exceeds maximum string length"
                    )));
                }
            }
            _ => {
                return Err(invalid(format!(
                    "Invalid ListResultPayload: \"{label}[{at}]\" must be a scalar or null"
                )));
            }
        }
    }
    Ok(values)
}

pub(crate) fn validate_list_result_payload(decoded: Map) -> ClusterResult<ListPage> {
    let mut decoded = decoded;
    let Some(Value::Array(entries)) = decoded.remove("entries") else {
        return Err(invalid(
            "Invalid ListResultPayload: \"entries\" must be an array".to_string(),
        ));
    };
    if entries.len() > MAX_LIMIT {
        return Err(invalid(format!(
            "Invalid ListResultPayload: \"entries\" exceeds maximum length of {MAX_LIMIT}"
        )));
    }
    let mut listed = Vec::with_capacity(entries.len());
    for (at, entry) in entries.into_iter().enumerate() {
        let Value::Object(mut entry) = entry else {
            return Err(invalid(format!(
                "Invalid ListResultPayload: \"entries[{at}]\" must be an object"
            )));
        };
        let doc_id = string_field(
            entry.get("docId"),
            &format!("entries[{at}].docId"),
            MAX_DOC_ID_LENGTH,
        )?
        .to_string();
        let Some(mut document @ Value::Object(_)) = entry.remove("document") else {
            return Err(invalid(format!(
                "Invalid ListResultPayload: \"entries[{at}].document\" must be an object"
            )));
        };
        restore_vector_values(&mut document);
        let sort_values = match entry.remove("sortValues") {
            None | Some(Value::Null) => None,
            Some(values) => Some(validate_sort_values(
                values,
                &format!("entries[{at}].sortValues"),
            )?),
        };
        listed.push(ListEntryWire {
            doc_id,
            document: into_record(document),
            sort_values,
        });
    }
    let total = non_negative_integer(decoded.get("total"), "total", MAX_COUNT_VALUE)?;
    let Some(Value::Bool(has_more)) = decoded.get("hasMore") else {
        return Err(invalid(
            "Invalid ListResultPayload: \"hasMore\" must be a boolean".to_string(),
        ));
    };
    Ok(ListPage {
        entries: listed,
        total,
        has_more: *has_more,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PreflightAnswer {
    pub(crate) count: u64,
    pub(crate) analysis_stale: bool,
}

pub(crate) fn validate_preflight_result_payload(decoded: Map) -> ClusterResult<PreflightAnswer> {
    let Some(count) = whole_number(decoded.get("count")).filter(|count| *count >= 0.0) else {
        return Err(invalid(
            "Invalid PreflightResultPayload: \"count\" must be a non-negative integer".to_string(),
        ));
    };
    let Some(Value::Bool(analysis_stale)) = decoded.get("analysisStale") else {
        return Err(invalid(
            "Invalid PreflightResultPayload: \"analysisStale\" must be a boolean".to_string(),
        ));
    };
    Ok(PreflightAnswer {
        count: count as u64,
        analysis_stale: *analysis_stale,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SuggestAnswer {
    pub(crate) terms: Vec<(String, u64)>,
    pub(crate) analysis_stale: bool,
}

pub(crate) fn validate_suggest_result_payload(decoded: Map) -> ClusterResult<SuggestAnswer> {
    let entries = array(
        decoded.get("terms"),
        "Invalid SuggestResultPayload: \"terms\" must be an array",
    )?;
    if entries.len() as f64 > MAX_SUGGEST_WIRE_LIMIT {
        return Err(invalid(format!(
            "Invalid SuggestResultPayload: \"terms\" exceeds maximum length of {MAX_SUGGEST_WIRE_LIMIT}"
        )));
    }
    let mut terms = Vec::with_capacity(entries.len());
    for (at, entry) in entries.iter().enumerate() {
        let entry = record(
            entry,
            format!("Invalid SuggestResultPayload: \"terms[{at}]\" must be an object"),
        )?;
        let term = string_field(
            entry.get("term"),
            &format!("terms[{at}].term"),
            MAX_TERM_LENGTH,
        )?;
        let frequency = non_negative_integer(
            entry.get("documentFrequency"),
            &format!("terms[{at}].documentFrequency"),
            MAX_COUNT_VALUE,
        )?;
        terms.push((term.to_string(), frequency));
    }
    let Some(Value::Bool(analysis_stale)) = decoded.get("analysisStale") else {
        return Err(invalid(
            "Invalid SuggestResultPayload: \"analysisStale\" must be a boolean".to_string(),
        ));
    };
    Ok(SuggestAnswer {
        terms,
        analysis_stale: *analysis_stale,
    })
}
