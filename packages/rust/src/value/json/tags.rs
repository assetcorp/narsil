use super::parse::parse_json_raw;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::base64;
use crate::value::{Map, Timestamp, Value};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_NANOSECONDS: f64 = 999_999_999.0;

fn refuse(path: &str, reason: &str) -> NarsilError {
    let place = if path.is_empty() { "(document)" } else { path };
    NarsilError::new(
        ErrorCode::DOC_VALIDATION_FAILED,
        format!("Field \"{place}\" {reason}"),
    )
}

fn untag_tag(tag: &str, value: Value, path: &str, depth: usize) -> Result<Value> {
    match tag {
        "$date" => {
            let pair = value.as_array().filter(|pair| pair.len() == 2);
            let (Some(seconds), Some(nanoseconds)) = (
                pair.and_then(|pair| pair[0].as_f64()),
                pair.and_then(|pair| pair[1].as_f64()),
            ) else {
                return Err(refuse(
                    path,
                    "holds a \"$date\" tag other than [seconds, nanoseconds]",
                ));
            };
            if seconds.fract() != 0.0 || seconds.abs() > MAX_SAFE_INTEGER {
                return Err(refuse(
                    path,
                    "holds a \"$date\" tag whose seconds are not an integer from -9007199254740991 to 9007199254740991",
                ));
            }
            if nanoseconds.fract() != 0.0 || !(0.0..=MAX_NANOSECONDS).contains(&nanoseconds) {
                return Err(refuse(
                    path,
                    "holds a \"$date\" tag whose nanoseconds are not an integer from 0 to 999999999",
                ));
            }
            Ok(Value::Timestamp(Timestamp {
                seconds: seconds as i64,
                nanoseconds: nanoseconds as u32,
            }))
        }
        "$bytes" => match value.as_str().and_then(base64::decode_exact) {
            Some(bytes) => Ok(Value::Bytes(bytes)),
            None => Err(refuse(
                path,
                "holds a \"$bytes\" tag whose text is not padded base64",
            )),
        },
        "$number" => match value.as_str() {
            Some("NaN") => Ok(Value::Number(f64::NAN)),
            Some("Infinity") => Ok(Value::Number(f64::INFINITY)),
            Some("-Infinity") => Ok(Value::Number(f64::NEG_INFINITY)),
            _ => Err(refuse(
                path,
                "holds a \"$number\" tag other than \"NaN\", \"Infinity\", or \"-Infinity\"",
            )),
        },
        "$object" => match value {
            Value::Object(map) => untag_map(map, path, depth),
            _ => Err(refuse(
                path,
                "holds an \"$object\" tag whose value is not an object",
            )),
        },
        _ => Err(refuse(
            path,
            &format!("holds an object whose only key, \"{tag}\", names no tag"),
        )),
    }
}

fn untag_map(map: Map, path: &str, depth: usize) -> Result<Value> {
    let mut out = Map::with_capacity(map.len());
    for (key, entry) in map {
        let child = if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        };
        out.insert(key, untag_value(entry, &child, depth + 1)?);
    }
    Ok(Value::Object(out))
}

/// Replaces each tag object inside `value` with the value that the tag stands for.
pub(crate) fn untag_value(value: Value, path: &str, depth: usize) -> Result<Value> {
    match value {
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for (at, item) in items.into_iter().enumerate() {
                out.push(untag_value(item, &format!("{path}[{at}]"), depth + 1)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(map) => {
            let tag = if map.len() == 1 {
                map.keys()
                    .next()
                    .filter(|key| key.starts_with('$'))
                    .cloned()
            } else {
                None
            };
            match tag {
                Some(tag) => {
                    let inner = map
                        .into_iter()
                        .next()
                        .map(|(_, inner)| inner)
                        .unwrap_or(Value::Null);
                    untag_tag(&tag, inner, path, depth)
                }
                None => untag_map(map, path, depth),
            }
        }
        other => Ok(other),
    }
}

/// Parses JSON text, reading each `$date`, `$bytes`, `$number`, and `$object` tag as the value that it stands for.
pub fn parse_json(text: &str) -> Result<Value> {
    untag_value(parse_json_raw(text)?, "", 0)
}
