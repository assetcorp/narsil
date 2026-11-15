use narsil::{Bm25FieldParams, Bm25Params, Map, Value};

use super::config_refusal;
use crate::documents::constants::{BM25_DISPLAYED_NAME_UNITS, MAX_BM25_B, MAX_BM25_K1};
use crate::documents::script_values::{script_text, script_type_name};
use crate::errors::Outcome;

const BM25_KEYS: [&str; 3] = ["k1", "b", "fields"];
const BM25_FIELD_KEYS: [&str; 2] = ["k1", "b"];

fn shortened(text: &str) -> String {
    let mut units = 0;
    let mut kept = String::new();
    for character in text.chars() {
        units += character.len_utf16();
        if units > BM25_DISPLAYED_NAME_UNITS {
            break;
        }
        kept.push(character);
    }
    kept
}

fn displayed(value: &Value) -> String {
    match value {
        Value::String(text) => format!("\"{}\"", shortened(text)),
        Value::Number(_) | Value::Bool(_) | Value::Null => script_text(value),
        other => format!("a value of type {}", script_type_name(other)),
    }
}

fn parameter_refusal(label: &str, message: String) -> crate::errors::ServerError {
    config_refusal(
        message,
        vec![("parameter", Value::String(label.to_string()))],
    )
}

fn required_value(label: &str, value: Option<&Value>, maximum: f64) -> Outcome<Option<f64>> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        Value::Number(number) if number.is_finite() && (0.0..=maximum).contains(number) => {
            Ok(Some(*number))
        }
        other => Err(parameter_refusal(
            label,
            format!(
                "{label} must be a finite number from 0 to {}, and this request sets {}",
                script_text(&Value::Number(maximum)),
                displayed(other)
            ),
        )),
    }
}

fn require_known_keys(label: &str, raw: &Map, known: &[&str]) -> Outcome<()> {
    match raw.keys().find(|key| !known.contains(&key.as_str())) {
        None => Ok(()),
        Some(key) => Err(parameter_refusal(
            label,
            format!(
                "{label} takes {}, and this request sets {}",
                known.join(", "),
                displayed(&Value::String(key.clone()))
            ),
        )),
    }
}

fn field_pair_of(name: &str, pair: &Value) -> Outcome<Bm25FieldParams> {
    let label = format!("bm25.fields.{}", shortened(name));
    let Value::Object(pair) = pair else {
        return Err(parameter_refusal(
            &label,
            format!("{label} must be an object that sets k1 or b"),
        ));
    };
    require_known_keys(&label, pair, &BM25_FIELD_KEYS)?;
    Ok(Bm25FieldParams {
        k1: required_value(&format!("{label}.k1"), pair.get("k1"), MAX_BM25_K1)?,
        b: required_value(&format!("{label}.b"), pair.get("b"), MAX_BM25_B)?,
    })
}

pub(super) fn bm25_of(raw: &Value) -> Outcome<Bm25Params> {
    let Value::Object(raw) = raw else {
        return Err(config_refusal(
            "bm25 must be an object that sets k1, b, or fields",
            Vec::new(),
        ));
    };
    require_known_keys("bm25", raw, &BM25_KEYS)?;
    let k1 = required_value("bm25.k1", raw.get("k1"), MAX_BM25_K1)?;
    let b = required_value("bm25.b", raw.get("b"), MAX_BM25_B)?;
    let fields = match raw.get("fields") {
        None => None,
        Some(Value::Object(fields)) => {
            let mut pairs = Vec::with_capacity(fields.len());
            for (name, pair) in fields.iter() {
                pairs.push((name.clone(), field_pair_of(name, pair)?));
            }
            Some(pairs)
        }
        Some(_) => {
            return Err(config_refusal(
                "bm25.fields must be an object that maps a field to its parameters",
                Vec::new(),
            ));
        }
    };
    Ok(Bm25Params { k1, b, fields })
}
