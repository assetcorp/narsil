use narsil::{Bm25FieldParams, Bm25Params, Map, Narsil, NarsilError, Value};

use super::constants::{MAX_BM25_B, MAX_BM25_K1};
use super::errors::{after_engine_checks, config_invalid};
use super::js_text::{displayed, displayed_name, number_text};
use crate::errors::{Outcome, ServerError};

const TOP_LEVEL_KEYS: [&str; 3] = ["k1", "b", "fields"];
const FIELD_KEYS: [&str; 2] = ["k1", "b"];
const PROVOKED_SUFFIX: &str = ", and this request sets NaN";

enum Shape {
    Valid(Bm25Params),
    TopLevel(ServerError),
    Field {
        checked: Vec<(String, Bm25FieldParams)>,
        name: String,
        failure: ServerError,
    },
}

fn parameter_problem(label: &str, message: String) -> ServerError {
    config_invalid(message).with_detail("parameter", Value::String(label.to_string()))
}

fn value_of(label: &str, value: Option<&Value>, maximum: f64) -> Outcome<Option<f64>> {
    match value {
        None => Ok(None),
        Some(Value::Number(number))
            if number.is_finite() && *number >= 0.0 && *number <= maximum =>
        {
            Ok(Some(*number))
        }
        Some(other) => Err(parameter_problem(
            label,
            format!(
                "{label} must be a finite number from 0 to {}, and this request sets {}",
                number_text(maximum),
                displayed(other)
            ),
        )),
    }
}

fn known_keys(label: &str, fields: &Map, known: &[&str]) -> Outcome<()> {
    match fields.keys().find(|key| !known.contains(&key.as_str())) {
        None => Ok(()),
        Some(key) => Err(parameter_problem(
            label,
            format!(
                "{label} takes {}, and this request sets {}",
                known.join(", "),
                displayed(&Value::String(key.clone()))
            ),
        )),
    }
}

fn field_pair(name: &str, pair: &Value) -> Outcome<Bm25FieldParams> {
    let label = format!("bm25.fields.{}", displayed_name(name));
    let Value::Object(pair) = pair else {
        return Err(parameter_problem(
            &label,
            format!("{label} must be an object that sets k1 or b"),
        ));
    };
    known_keys(&label, pair, &FIELD_KEYS)?;
    Ok(Bm25FieldParams {
        k1: value_of(&format!("{label}.k1"), pair.get("k1"), MAX_BM25_K1)?,
        b: value_of(&format!("{label}.b"), pair.get("b"), MAX_BM25_B)?,
    })
}

fn top_level(body: &Value) -> Outcome<(Option<f64>, Option<f64>, Option<&Map>)> {
    let Value::Object(fields) = body else {
        return Err(config_invalid(
            "bm25 must be an object that sets k1, b, or fields",
        ));
    };
    known_keys("bm25", fields, &TOP_LEVEL_KEYS)?;
    let k1 = value_of("bm25.k1", fields.get("k1"), MAX_BM25_K1)?;
    let b = value_of("bm25.b", fields.get("b"), MAX_BM25_B)?;
    match fields.get("fields") {
        None => Ok((k1, b, None)),
        Some(Value::Object(named)) => Ok((k1, b, Some(named))),
        Some(_) => Err(config_invalid(
            "bm25.fields must be an object that maps a field to its parameters",
        )),
    }
}

fn shape_of(body: &Value) -> Shape {
    let (k1, b, named) = match top_level(body) {
        Ok(parts) => parts,
        Err(failure) => return Shape::TopLevel(failure),
    };
    let Some(named) = named else {
        return Shape::Valid(Bm25Params {
            k1,
            b,
            fields: None,
        });
    };
    let mut checked = Vec::with_capacity(named.len());
    for (name, pair) in named.iter() {
        match field_pair(name, pair) {
            Ok(pair) => checked.push((name.clone(), pair)),
            Err(failure) => {
                return Shape::Field {
                    checked,
                    name: name.clone(),
                    failure,
                };
            }
        }
    }
    Shape::Valid(Bm25Params {
        k1,
        b,
        fields: Some(checked),
    })
}

fn provoked(raised: &NarsilError) -> bool {
    raised.code().as_str() == "CONFIG_INVALID" && raised.message().ends_with(PROVOKED_SUFFIX)
}

fn not_a_number() -> Bm25FieldParams {
    Bm25FieldParams {
        k1: Some(f64::NAN),
        b: None,
    }
}

pub(crate) fn update_bm25(engine: &Narsil, index_name: &str, body: &Value) -> Outcome<()> {
    match shape_of(body) {
        Shape::Valid(params) => engine
            .update_bm25(index_name, &params)
            .map_err(ServerError::from),
        Shape::TopLevel(failure) => {
            let sentinel = Bm25Params {
                k1: Some(f64::NAN),
                ..Bm25Params::default()
            };
            Err(after_engine_checks(
                engine,
                failure,
                |engine| engine.update_bm25(index_name, &sentinel),
                provoked,
            ))
        }
        Shape::Field {
            mut checked,
            name,
            failure,
        } => {
            checked.push((name, not_a_number()));
            let sentinel = Bm25Params {
                fields: Some(checked),
                ..Bm25Params::default()
            };
            Err(after_engine_checks(
                engine,
                failure,
                |engine| engine.update_bm25(index_name, &sentinel),
                provoked,
            ))
        }
    }
}
