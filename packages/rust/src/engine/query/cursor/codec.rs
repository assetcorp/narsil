use super::base64::decode_as_node;
use super::constants::{
    MAX_CURSOR_ANCHOR_CODE_POINTS, MAX_CURSOR_UTF16_UNITS, MAX_SORT_FIELDS,
    MAX_SORT_VALUE_CODE_POINTS,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::base64;
use crate::value::{Map, Value, number_to_text, parse_json_raw, write_exact_json_into};

const CURSOR_VERSION: f64 = 4.0;
const NON_FINITE_CURSOR_VERSION: f64 = 5.0;
const BINDING_HEX_DIGITS: usize = 8;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The decoded paging cursor that a search and a listing share: the last document returned, the score or the sort
/// key that the next page seeks past, the number of results before the next page, and the binding of the request
/// that produced it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PageCursor {
    pub(crate) anchor: String,
    pub(crate) score: Option<f64>,
    pub(crate) sort_key: Option<Vec<Value>>,
    pub(crate) sort_signature: Option<String>,
    pub(crate) depth: u64,
    pub(crate) binding: String,
}

fn invalid_cursor(reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::SEARCH_INVALID_CURSOR,
        format!("Failed to decode cursor: {reason}"),
    )
}

fn write_json_number(out: &mut String, number: f64) {
    if !number.is_finite() {
        out.push_str("null");
    } else if number == 0.0 {
        out.push('0');
    } else {
        out.push_str(&number_to_text(number));
    }
}

fn write_json_string(out: &mut String, text: &str) {
    write_exact_json_into(out, &Value::String(text.to_string()));
}

fn write_sort_value(out: &mut String, value: &Value) {
    match value {
        Value::String(text) => write_json_string(out, text),
        Value::Number(number) => write_json_number(out, *number),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        _ => out.push_str("null"),
    }
}

/// Encodes a cursor as the base64 JSON text that the reference engine writes, with its members in the same order,
/// so that both engines hand out the same cursor for the same page.
pub(crate) fn encode_page_cursor(cursor: &PageCursor) -> String {
    let non_finite = cursor.sort_key.is_none() || cursor.sort_signature.is_none();
    let non_finite = non_finite && cursor.score.is_some_and(|score| !score.is_finite());
    let mut json = String::from(if non_finite {
        "{\"v\":5,\"a\":"
    } else {
        "{\"v\":4,\"a\":"
    });
    write_json_string(&mut json, &cursor.anchor);
    match (&cursor.sort_key, &cursor.sort_signature) {
        (Some(key), Some(signature)) => {
            json.push_str(",\"k\":[");
            for (at, value) in key.iter().enumerate() {
                if at > 0 {
                    json.push(',');
                }
                write_sort_value(&mut json, value);
            }
            json.push_str("],\"o\":");
            write_json_string(&mut json, signature);
        }
        _ => {
            if let Some(score) = cursor.score {
                json.push_str(",\"s\":");
                if score.is_finite() {
                    write_json_number(&mut json, score);
                } else {
                    write_json_string(&mut json, &number_to_text(score));
                }
            }
        }
    }
    if cursor.depth > 0 {
        json.push_str(",\"d\":");
        json.push_str(&cursor.depth.to_string());
    }
    json.push_str(",\"q\":");
    write_json_string(&mut json, &cursor.binding);
    json.push('}');
    base64::encode(json.as_bytes())
}

fn exceeds_utf16_units(text: &str, maximum: usize) -> bool {
    text.len() > maximum && text.encode_utf16().nth(maximum).is_some()
}

fn exceeds_code_points(text: &str, maximum: usize) -> bool {
    text.len() > maximum && text.chars().nth(maximum).is_some()
}

fn is_binding(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(text))
        if text.len() == BINDING_HEX_DIGITS
            && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
}

fn decode_sort_key(value: &Value) -> Result<Vec<Value>> {
    let Value::Array(items) = value else {
        return Err(invalid_cursor("\"k\" must be an array"));
    };
    if items.len() > MAX_SORT_FIELDS {
        return Err(invalid_cursor("\"k\" carries too many sort values"));
    }
    let mut key = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::Null | Value::Bool(_) => key.push(item.clone()),
            Value::Number(number) if number.is_finite() => key.push(item.clone()),
            Value::Number(_) => {
                return Err(invalid_cursor("\"k\" holds a number that is not finite"));
            }
            Value::String(text) if exceeds_code_points(text, MAX_SORT_VALUE_CODE_POINTS) => {
                return Err(invalid_cursor("\"k\" holds an oversized sort value"));
            }
            Value::String(_) => key.push(item.clone()),
            _ => {
                return Err(invalid_cursor(
                    "\"k\" accepts a string, a finite number, a boolean, or null",
                ));
            }
        }
    }
    Ok(key)
}

fn decoded_object(cursor: &str) -> Result<Map> {
    if exceeds_utf16_units(cursor, MAX_CURSOR_UTF16_UNITS) {
        return Err(invalid_cursor("the cursor is too long"));
    }
    let bytes = decode_as_node(cursor);
    let text = String::from_utf8_lossy(&bytes);
    match parse_json_raw(&text) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(invalid_cursor("expected an object")),
        Err(_) => Err(invalid_cursor("invalid base64 or JSON encoding")),
    }
}

fn non_finite_score(text: &str) -> Option<f64> {
    match text {
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        "NaN" => Some(f64::NAN),
        _ => None,
    }
}

fn versioned_score(object: &Map) -> Option<Option<f64>> {
    let version = object.get("v");
    let score = object.get("s");
    if version == Some(&Value::Number(CURSOR_VERSION)) {
        return match score {
            None => Some(None),
            Some(Value::Number(score)) if score.is_finite() => Some(Some(*score)),
            Some(_) => None,
        };
    }
    if version != Some(&Value::Number(NON_FINITE_CURSOR_VERSION))
        || object.contains_key("k")
        || object.contains_key("o")
    {
        return None;
    }
    match score {
        Some(Value::String(text)) => non_finite_score(text).map(Some),
        _ => None,
    }
}

/// Decodes a cursor and checks it against every rule of the cursor format, in the order that the reference engine
/// checks them, raising `SEARCH_INVALID_CURSOR` with the same reason where one fails.
pub(crate) fn decode_page_cursor(cursor: &str) -> Result<PageCursor> {
    let object = decoded_object(cursor)?;
    let binding = object.get("q");
    if !is_binding(binding) {
        return Err(invalid_cursor("\"q\" must be 8 lowercase hex digits"));
    }
    let anchor = match object.get("a") {
        Some(Value::String(anchor)) if !anchor.is_empty() => anchor,
        _ => return Err(invalid_cursor("\"a\" must be a non-empty string")),
    };
    if exceeds_code_points(anchor, MAX_CURSOR_ANCHOR_CODE_POINTS) {
        return Err(invalid_cursor("\"a\" is too long to be a document id"));
    }
    let score = versioned_score(&object)
        .ok_or_else(|| invalid_cursor("invalid score for the cursor version"))?;
    if score.is_some() && object.contains_key("k") {
        return Err(invalid_cursor(
            "a cursor carries \"s\" or \"k\", never both",
        ));
    }
    let depth = match object.get("d") {
        None => 0,
        Some(Value::Number(depth))
            if depth.fract() == 0.0 && *depth >= 1.0 && *depth <= MAX_SAFE_INTEGER =>
        {
            *depth as u64
        }
        Some(_) => return Err(invalid_cursor("\"d\" must be a positive integer")),
    };
    let sort_key = object.get("k").map(decode_sort_key).transpose()?;
    let sort_signature = match object.get("o") {
        None => None,
        Some(Value::String(signature)) => Some(signature.clone()),
        Some(_) => return Err(invalid_cursor("\"o\" must be a string")),
    };
    if sort_key.is_none() != sort_signature.is_none() {
        return Err(invalid_cursor("\"k\" and \"o\" have to arrive together"));
    }
    Ok(PageCursor {
        anchor: anchor.clone(),
        score,
        sort_key,
        sort_signature,
        depth,
        binding: binding
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default(),
    })
}

/// Raises `SEARCH_INVALID_CURSOR` for a cursor that another request produced: one whose binding differs, a sorted
/// cursor under another sort or on an unsorted request, or a score cursor where the request anchors on the
/// document ID alone, as a listing does.
pub(crate) fn require_matching_cursor(
    cursor: &PageCursor,
    signature: Option<&str>,
    score_anchored: bool,
    binding: &str,
) -> Result<()> {
    if cursor.binding != binding {
        return Err(invalid_cursor("the cursor belongs to a different query"));
    }
    if let Some(signature) = signature {
        if cursor.sort_signature.as_deref() != Some(signature) {
            return Err(invalid_cursor(
                "the cursor belongs to a different sort order",
            ));
        }
        return Ok(());
    }
    if cursor.sort_signature.is_some() {
        return Err(invalid_cursor("the cursor belongs to a sorted request"));
    }
    if score_anchored && cursor.score.is_none() {
        return Err(invalid_cursor("the cursor carries no score to seek from"));
    }
    if !score_anchored && cursor.score.is_some() {
        return Err(invalid_cursor(
            "the cursor belongs to a search rather than a listing",
        ));
    }
    Ok(())
}
