use narsil::{Map, Value};

use crate::constants::{MAX_INDEX_NAME_LENGTH, MAX_PARTITION_COUNT};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;
use crate::node::decode_request_payload;

pub(super) fn invalid(code: &str, message: impl Into<String>) -> ClusterError {
    ClusterError::new(code, message)
}

pub(super) fn request_fields(message: &TransportMessage, payload_name: &str) -> ClusterResult<Map> {
    match decode_request_payload(&message.payload, &message.message_type)? {
        Value::Object(fields) => Ok(fields),
        _ => Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid {payload_name}: expected an object"),
        )),
    }
}

pub(super) fn absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(super) fn string_field(
    value: Option<&Value>,
    label: &str,
    max_length: usize,
    code: &str,
) -> ClusterResult<String> {
    let Some(Value::String(text)) = value else {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" must be a string"),
        ));
    };
    if text.is_empty() {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" must be a non-empty string"),
        ));
    }
    let length = utf16_length(text);
    if length > max_length {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" exceeds maximum length of {max_length}"),
        )
        .with_detail("length", Value::from(length))
        .with_detail("limit", Value::from(max_length)));
    }
    if text.contains('\0') {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" must not contain null bytes"),
        ));
    }
    Ok(text.clone())
}

pub(super) fn index_name(fields: &Map, payload_name: &str) -> ClusterResult<String> {
    string_field(
        fields.get("indexName"),
        &format!("{payload_name}.indexName"),
        MAX_INDEX_NAME_LENGTH,
        codes::CONFIG_INVALID,
    )
}

fn whole_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

pub(super) fn positive_integer(
    value: Option<&Value>,
    label: &str,
    max_value: f64,
    code: &str,
) -> ClusterResult<u64> {
    let Some(number) = whole_number(value).filter(|number| *number > 0.0) else {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" must be a finite positive integer"),
        ));
    };
    if number > max_value {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" exceeds maximum value of {max_value}"),
        )
        .with_detail("value", Value::Number(number))
        .with_detail("limit", Value::Number(max_value)));
    }
    Ok(number as u64)
}

pub(super) fn bounded_integer(
    value: Option<&Value>,
    label: &str,
    max_value: f64,
    payload_name: &str,
) -> ClusterResult<Option<u32>> {
    if absent(value) {
        return Ok(None);
    }
    match whole_number(value) {
        Some(number) if (0.0..=max_value).contains(&number) => Ok(Some(number as u32)),
        _ => Err(invalid(
            codes::CONFIG_INVALID,
            format!(
                "Invalid {payload_name}: \"{label}\" must be a non-negative integer at most {max_value}"
            ),
        )),
    }
}

pub(super) fn partition_ids(fields: &Map) -> ClusterResult<Vec<u32>> {
    let label = "partitionIds";
    let Some(Value::Array(items)) = fields.get(label) else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid payload: \"{label}\" must be an array"),
        ));
    };
    let limit = MAX_PARTITION_COUNT as usize;
    if items.len() > limit {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid payload: \"{label}\" exceeds maximum length of {limit}"),
        )
        .with_detail("length", Value::from(items.len()))
        .with_detail("limit", Value::from(limit)));
    }
    let mut ids = Vec::with_capacity(items.len());
    for (at, item) in items.iter().enumerate() {
        let Some(number) = whole_number(Some(item)) else {
            return Err(invalid(
                codes::CONFIG_INVALID,
                format!("Invalid payload: \"{label}[{at}]\" must be a finite integer"),
            ));
        };
        if !(0.0..MAX_PARTITION_COUNT).contains(&number) {
            return Err(invalid(
                codes::CONFIG_INVALID,
                format!(
                    "Invalid payload: \"{label}[{at}]\" must be between 0 and {}",
                    MAX_PARTITION_COUNT - 1.0
                ),
            )
            .with_detail("value", Value::Number(number))
            .with_detail("limit", Value::Number(MAX_PARTITION_COUNT)));
        }
        ids.push(number as u32);
    }
    Ok(ids)
}

pub(super) fn string_list(
    value: Option<&Value>,
    label: &str,
    max_count: usize,
    max_length: usize,
    code: &str,
) -> ClusterResult<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" must be an array"),
        ));
    };
    if items.len() > max_count {
        return Err(invalid(
            code,
            format!("Invalid payload: \"{label}\" exceeds maximum length of {max_count}"),
        )
        .with_detail("length", Value::from(items.len()))
        .with_detail("limit", Value::from(max_count)));
    }
    items
        .iter()
        .enumerate()
        .map(|(at, item)| string_field(Some(item), &format!("{label}[{at}]"), max_length, code))
        .collect()
}

pub(super) fn optional_flag(
    value: Option<&Value>,
    label: &str,
    payload_name: &str,
) -> ClusterResult<Option<bool>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid {payload_name}: \"{label}\" must be a boolean"),
        )),
    }
}

pub(super) fn analysis_generation(fields: &Map, payload_name: &str) -> ClusterResult<u64> {
    let value = fields.get("analysisGeneration");
    if absent(value) {
        return Ok(0);
    }
    match whole_number(value) {
        Some(number) if (0.0..=crate::constants::MAX_SAFE_INTEGER as f64).contains(&number) => {
            Ok(number as u64)
        }
        _ => Err(invalid(
            codes::CONFIG_INVALID,
            format!(
                "Invalid {payload_name}: \"analysisGeneration\" must be a non-negative integer"
            ),
        )),
    }
}

pub(super) fn answer(
    message: &TransportMessage,
    reply_type: &str,
    node_id: &str,
    payload: Map,
) -> ClusterResult<TransportMessage> {
    Ok(TransportMessage::new(
        reply_type,
        node_id,
        message.request_id.as_str(),
        narsil::encode_msgpack(&Value::Object(payload))?,
    ))
}
