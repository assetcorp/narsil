use std::collections::HashSet;

use narsil::{Map, Value};

const FLOAT32_BYTES: usize = 4;

fn same_number(sent: f64, stored: f64) -> bool {
    sent == stored || (sent.is_nan() && stored.is_nan())
}

fn numbers_of(value: &Value) -> Option<Vec<f64>> {
    let Value::Array(entries) = value else {
        return None;
    };
    entries
        .iter()
        .map(|entry| match entry {
            Value::Number(number) => Some(*number),
            _ => None,
        })
        .collect()
}

fn stored_vector_of(value: &Value) -> Option<Vec<f64>> {
    let Value::Bytes(bytes) = value else {
        return numbers_of(value);
    };
    let (values, rest) = bytes.as_chunks::<FLOAT32_BYTES>();
    if !rest.is_empty() {
        return None;
    }
    Some(
        values
            .iter()
            .map(|value| f64::from(f32::from_le_bytes(*value)))
            .collect(),
    )
}

fn same_vector(sent: &[f64], stored: &[f64]) -> bool {
    sent.len() == stored.len()
        && sent.iter().zip(stored).all(|(sent, stored)| {
            same_number(*sent, *stored)
                || same_number(f64::from(*sent as f32), f64::from(*stored as f32))
        })
}

fn field_path(parent: &str, key: &str) -> String {
    if parent.is_empty() {
        key.to_string()
    } else {
        format!("{parent}.{key}")
    }
}

fn matches_record(sent: &Map, stored: &Map, path: &str, derived: &HashSet<String>) -> bool {
    for (key, value) in sent.iter() {
        let Some(held) = stored.get(key) else {
            return false;
        };
        if !matches_sent(value, held, &field_path(path, key), derived) {
            return false;
        }
    }
    stored
        .keys()
        .filter(|key| !sent.contains_key(key))
        .all(|key| derived.contains(&field_path(path, key)))
}

fn matches_sent(sent: &Value, stored: &Value, path: &str, derived: &HashSet<String>) -> bool {
    if let (Some(sent), Some(stored)) = (numbers_of(sent), stored_vector_of(stored)) {
        return same_vector(&sent, &stored);
    }
    match (sent, stored) {
        (Value::Array(sent), Value::Array(stored)) => {
            let none = HashSet::new();
            sent.len() == stored.len()
                && sent
                    .iter()
                    .zip(stored)
                    .all(|(sent, stored)| matches_sent(sent, stored, path, &none))
        }
        (Value::Object(sent), Value::Object(stored)) => matches_record(sent, stored, path, derived),
        (Value::Number(sent), Value::Number(stored)) => same_number(*sent, *stored),
        _ => sent == stored,
    }
}

pub(super) fn stored_copy_matches_sent(
    sent: &Map,
    stored: &Map,
    derived: &HashSet<String>,
) -> bool {
    matches_record(sent, stored, "", derived)
}
