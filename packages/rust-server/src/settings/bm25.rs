use narsil::{Bm25FieldParams, Bm25Params, ErrorCode, Map, Narsil, NarsilError, Value};

use super::constants::{MAX_BM25_B, MAX_BM25_K1};
use super::errors::after_engine_checks;
use crate::errors::{Outcome, ServerError};
use crate::script_values::{displayed, displayed_name, script_text};

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
    ServerError::config_invalid(message).with_detail("parameter", Value::String(label.to_string()))
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
                script_text(&Value::Number(maximum)),
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
        return Err(ServerError::config_invalid(
            "bm25 must be an object that sets k1, b, or fields",
        ));
    };
    known_keys("bm25", fields, &TOP_LEVEL_KEYS)?;
    let k1 = value_of("bm25.k1", fields.get("k1"), MAX_BM25_K1)?;
    let b = value_of("bm25.b", fields.get("b"), MAX_BM25_B)?;
    match fields.get("fields") {
        None => Ok((k1, b, None)),
        Some(Value::Object(named)) => Ok((k1, b, Some(named))),
        Some(_) => Err(ServerError::config_invalid(
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

pub(crate) fn bm25_params_of(body: &Value) -> Outcome<Bm25Params> {
    match shape_of(body) {
        Shape::Valid(params) => Ok(params),
        Shape::TopLevel(failure) | Shape::Field { failure, .. } => Err(failure),
    }
}

pub(crate) struct UnknownBm25Key {
    sentinel: Bm25Params,
    failure: ServerError,
}

impl UnknownBm25Key {
    pub(crate) fn refusal<T>(
        self,
        engine: &Narsil,
        search: impl FnOnce(&Narsil, Bm25Params) -> narsil::Result<T>,
    ) -> ServerError {
        let sentinel = self.sentinel;
        after_engine_checks(
            engine,
            self.failure,
            |engine| search(engine, sentinel),
            provoked,
        )
    }

    #[cfg(feature = "cluster")]
    pub(crate) fn into_parts(self) -> (Bm25Params, ServerError) {
        (self.sentinel, self.failure)
    }
}

#[cfg(feature = "cluster")]
pub(crate) fn provoked_refusal(raised: &ServerError) -> bool {
    raised.code == ErrorCode::CONFIG_INVALID.as_str() && raised.message.ends_with(PROVOKED_SUFFIX)
}

pub(crate) fn unknown_bm25_key(raw: &Map, params: &Bm25Params) -> Option<UnknownBm25Key> {
    if let Err(failure) = known_keys("bm25", raw, &TOP_LEVEL_KEYS) {
        let sentinel = Bm25Params {
            k1: Some(f64::NAN),
            ..Bm25Params::default()
        };
        return Some(UnknownBm25Key { sentinel, failure });
    }
    let Some(Value::Object(named)) = raw.get("fields") else {
        return None;
    };
    let converted = params.fields.as_deref().unwrap_or_default();
    named.iter().enumerate().find_map(|(at, (name, pair))| {
        let Value::Object(pair) = pair else {
            return None;
        };
        let label = format!("bm25.fields.{}", displayed_name(name));
        let failure = known_keys(&label, pair, &FIELD_KEYS).err()?;
        let mut checked = converted.get(..at).map(<[_]>::to_vec).unwrap_or_default();
        checked.push((name.clone(), not_a_number()));
        let sentinel = Bm25Params {
            k1: params.k1,
            b: params.b,
            fields: Some(checked),
        };
        Some(UnknownBm25Key { sentinel, failure })
    })
}

fn provoked(raised: &NarsilError) -> bool {
    raised.code() == ErrorCode::CONFIG_INVALID && raised.message().ends_with(PROVOKED_SUFFIX)
}

fn not_a_number() -> Bm25FieldParams {
    Bm25FieldParams {
        k1: Some(f64::NAN),
        b: None,
    }
}

pub(crate) enum Bm25Change {
    Valid(Bm25Params),
    Refused {
        sentinel: Bm25Params,
        failure: ServerError,
    },
}

pub(crate) fn bm25_change_of(body: &Value) -> Bm25Change {
    match shape_of(body) {
        Shape::Valid(params) => Bm25Change::Valid(params),
        Shape::TopLevel(failure) => {
            let sentinel = Bm25Params {
                k1: Some(f64::NAN),
                ..Bm25Params::default()
            };
            Bm25Change::Refused { sentinel, failure }
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
            Bm25Change::Refused { sentinel, failure }
        }
    }
}

pub(crate) fn update_bm25(engine: &Narsil, index_name: &str, body: &Value) -> Outcome<()> {
    match bm25_change_of(body) {
        Bm25Change::Valid(params) => engine
            .update_bm25(index_name, &params)
            .map_err(ServerError::from),
        Bm25Change::Refused { sentinel, failure } => Err(after_engine_checks(
            engine,
            failure,
            |engine| engine.update_bm25(index_name, &sentinel),
            provoked,
        )),
    }
}
