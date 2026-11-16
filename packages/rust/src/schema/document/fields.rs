use super::{failed, kind_of, typeof_of};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::compiled::LevelEntry;
use crate::schema::{BaseType, FieldType};
use crate::value::{Map, Value, number_to_text};

fn coordinate_kind(coordinate: Option<&Value>) -> &'static str {
    match coordinate {
        None => "undefined",
        Some(Value::Number(number)) if number.is_nan() => "NaN",
        Some(other) => typeof_of(other),
    }
}

fn validate_geopoint(path: &str, value: &Value) -> Result<()> {
    let invalid = |message: String, details: Vec<(&str, Value)>| {
        NarsilError::new(ErrorCode::SCHEMA_INVALID_GEOPOINT, message)
            .with_details([("field", Value::from(path))].into_iter().chain(details))
    };
    let Value::Object(point) = value else {
        return Err(invalid(
            format!("Field \"{path}\" expected a geopoint object with lat and lon"),
            vec![("received", Value::from(kind_of(value)))],
        ));
    };
    let lat = point
        .get("lat")
        .and_then(Value::as_f64)
        .filter(|lat| !lat.is_nan());
    let lon = point
        .get("lon")
        .and_then(Value::as_f64)
        .filter(|lon| !lon.is_nan());
    let (Some(lat), Some(lon)) = (lat, lon) else {
        return Err(invalid(
            format!("Field \"{path}\" geopoint requires numeric lat and lon"),
            vec![
                ("lat", Value::from(coordinate_kind(point.get("lat")))),
                ("lon", Value::from(coordinate_kind(point.get("lon")))),
            ],
        ));
    };
    if !(-90.0..=90.0).contains(&lat) {
        return Err(invalid(
            format!("Field \"{path}\" geopoint lat must be between -90 and 90"),
            vec![("lat", Value::Number(lat))],
        ));
    }
    if !(-180.0..=180.0).contains(&lon) {
        return Err(invalid(
            format!("Field \"{path}\" geopoint lon must be between -180 and 180"),
            vec![("lon", Value::Number(lon))],
        ));
    }
    Ok(())
}

fn is_float32_finite(number: f64) -> bool {
    (number as f32).is_finite()
}

fn validate_vector(path: &str, value: &Value, dimension: u32) -> Result<()> {
    let Value::Array(items) = value else {
        return Err(failed(format!(
            "Field \"{path}\" expected a vector (Array or Float32Array)"
        ))
        .with_details([
            ("field", Value::from(path)),
            ("received", Value::from(typeof_of(value))),
        ]));
    };
    if items.len() != dimension as usize {
        return Err(failed(format!(
            "Field \"{path}\" expected vector of dimension {dimension}, got {}",
            items.len()
        ))
        .with_details([
            ("field", Value::from(path)),
            ("expected", Value::from(dimension)),
            ("received", Value::from(items.len())),
        ]));
    }
    for (at, item) in items.iter().enumerate() {
        let valid = matches!(item, Value::Number(number) if is_float32_finite(*number));
        if !valid {
            return Err(failed(format!(
                "Field \"{path}\" vector element at index {at} is not a valid number"
            ))
            .with_details([
                ("field", Value::from(path)),
                ("index", Value::from(at)),
                ("value", item.clone()),
            ]));
        }
    }
    Ok(())
}

fn validate_typed_list(path: &str, value: &Value, element: BaseType) -> Result<()> {
    let Value::Array(items) = value else {
        return Err(
            failed(format!("Field \"{path}\" expected an array")).with_details([
                ("field", Value::from(path)),
                ("received", Value::from(typeof_of(value))),
            ]),
        );
    };
    let expected = match element {
        BaseType::Number => "number",
        BaseType::Boolean => "boolean",
        _ => "string",
    };
    for (at, item) in items.iter().enumerate() {
        let kind = typeof_of(item);
        if kind != expected {
            return Err(failed(format!(
                "Field \"{path}\" array element at index {at} expected {expected}, got {kind}"
            ))
            .with_details([
                ("field", Value::from(path)),
                ("index", Value::from(at)),
                ("expected", Value::from(expected)),
                ("received", Value::from(kind)),
            ]));
        }
        if let Value::Number(number) = item
            && !number.is_finite()
        {
            return Err(failed(format!(
                "Field \"{path}\" array element at index {at} is {}, while a number field holds finite numbers alone",
                number_to_text(*number)
            ))
            .with_details([("field", Value::from(path)), ("index", Value::from(at))]));
        }
    }
    Ok(())
}

fn validate_pattern_value(
    path: &str,
    text: &str,
    limit: usize,
    index: Option<usize>,
) -> Result<()> {
    if text.chars().nth(limit).is_none() {
        return Ok(());
    }
    let subject = match index {
        None => format!("The value of field \"{path}\""),
        Some(at) => format!("Element {at} of field \"{path}\""),
    };
    let details = [("field", Value::from(path)), ("limit", Value::from(limit))]
        .into_iter()
        .chain(index.map(|at| ("index", Value::from(at))));
    Err(failed(format!(
        "{subject} is longer than {limit} code points, which is the pattern value limit of this index"
    ))
    .with_details(details))
}

fn mismatched(path: &str, message: String, expected: &str, received: Value) -> NarsilError {
    failed(message).with_details([
        ("field", Value::from(path)),
        ("expected", Value::from(expected)),
        ("received", received),
    ])
}

fn validate_field_value(
    path: &str,
    value: &Value,
    field_type: &FieldType,
    limit: usize,
) -> Result<()> {
    match field_type.base {
        BaseType::String | BaseType::Verbatim => {
            let Value::String(text) = value else {
                let kind = typeof_of(value);
                return Err(mismatched(
                    path,
                    format!("Field \"{path}\" expected string, got {kind}"),
                    "string",
                    Value::from(kind),
                ));
            };
            if field_type.pattern {
                validate_pattern_value(path, text, limit, None)?;
            }
            Ok(())
        }
        BaseType::Number => match value {
            Value::Number(number) if number.is_finite() => Ok(()),
            other => {
                let received = match other {
                    Value::Number(number) => number_to_text(*number),
                    _ => typeof_of(other).to_string(),
                };
                Err(mismatched(
                    path,
                    format!("Field \"{path}\" expected a finite number"),
                    "number",
                    Value::from(received),
                ))
            }
        },
        BaseType::Boolean => match value {
            Value::Bool(_) => Ok(()),
            other => {
                let kind = typeof_of(other);
                Err(mismatched(
                    path,
                    format!("Field \"{path}\" expected boolean, got {kind}"),
                    "boolean",
                    Value::from(kind),
                ))
            }
        },
        BaseType::Enum => match value {
            Value::String(_) => Ok(()),
            other => {
                let kind = typeof_of(other);
                Err(mismatched(
                    path,
                    format!("Field \"{path}\" expected enum (string), got {kind}"),
                    "enum",
                    Value::from(kind),
                ))
            }
        },
        BaseType::Geopoint => validate_geopoint(path, value),
        BaseType::StringList | BaseType::VerbatimList => {
            validate_typed_list(path, value, BaseType::String)?;
            if field_type.pattern
                && let Value::Array(items) = value
            {
                for (at, item) in items.iter().enumerate() {
                    if let Value::String(text) = item {
                        validate_pattern_value(path, text, limit, Some(at))?;
                    }
                }
            }
            Ok(())
        }
        BaseType::NumberList => validate_typed_list(path, value, BaseType::Number),
        BaseType::BooleanList => validate_typed_list(path, value, BaseType::Boolean),
        BaseType::EnumList => validate_typed_list(path, value, BaseType::String),
        BaseType::Vector => validate_vector(path, value, field_type.dimension),
    }
}

pub(super) fn validate_level(document: &Map, levels: &[LevelEntry], limit: usize) -> Result<()> {
    for entry in levels {
        match entry {
            LevelEntry::Nested {
                field,
                path,
                children,
            } => match document.get(field) {
                None | Some(Value::Null) => {}
                Some(Value::Object(nested)) => validate_level(nested, children, limit)?,
                Some(other) => {
                    return Err(failed(format!("Field \"{path}\" expected an object"))
                        .with_details([
                            ("field", Value::from(path.as_str())),
                            ("received", Value::from(kind_of(other))),
                        ]));
                }
            },
            LevelEntry::Leaf {
                field,
                path,
                field_type,
            } => match document.get(field) {
                None | Some(Value::Null) => {}
                Some(value) => validate_field_value(path, value, field_type, limit)?,
            },
        }
    }
    Ok(())
}
