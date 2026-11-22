use std::collections::BTreeMap;

use narsil::{Map, Value};

use crate::constants::MAX_SCHEMA_DEPTH;

const ABSENT: &str = "(absent)";
const DEPTH_EXCEEDED: &str = "depth-exceeded";

fn members(value: &Value) -> Option<BTreeMap<String, &Value>> {
    match value {
        Value::Object(fields) => Some(
            fields
                .iter()
                .map(|(key, field)| (key.clone(), field))
                .collect(),
        ),
        Value::Array(items) => Some(
            items
                .iter()
                .enumerate()
                .map(|(position, item)| (position.to_string(), item))
                .collect(),
        ),
        _ => None,
    }
}

fn described(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Object(_) | Value::Array(_) => "object".to_string(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => format!("{other:?}"),
    }
}

fn difference(path: &str, expected: &str, actual: &str) -> Value {
    let mut entry = Map::with_capacity(3);
    entry.insert("path", Value::String(path.to_string()));
    entry.insert("expected", Value::String(expected.to_string()));
    entry.insert("actual", Value::String(actual.to_string()));
    Value::Object(entry)
}

fn walk(expected: &Value, actual: &Value, prefix: &str, depth: usize, found: &mut Vec<Value>) {
    if depth > MAX_SCHEMA_DEPTH {
        let path = if prefix.is_empty() {
            DEPTH_EXCEEDED
        } else {
            prefix
        };
        found.push(difference(path, DEPTH_EXCEEDED, DEPTH_EXCEEDED));
        return;
    }
    let (Some(expected_members), Some(mut actual_members)) = (members(expected), members(actual))
    else {
        return;
    };
    for (key, expected_value) in &expected_members {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        let Some(actual_value) = actual_members.remove(key) else {
            found.push(difference(&path, &described(expected_value), ABSENT));
            continue;
        };
        match (
            members(expected_value).is_some(),
            members(actual_value).is_some(),
        ) {
            (true, true) => walk(expected_value, actual_value, &path, depth + 1, found),
            (false, false) if *expected_value == actual_value => {}
            _ => found.push(difference(
                &path,
                &described(expected_value),
                &described(actual_value),
            )),
        }
    }
    for (key, actual_value) in actual_members {
        let path = if prefix.is_empty() {
            key
        } else {
            format!("{prefix}.{key}")
        };
        found.push(difference(&path, ABSENT, &described(actual_value)));
    }
}

pub(super) fn schema_differences(expected: &Value, actual: &Value) -> Vec<Value> {
    let mut found = Vec::new();
    walk(expected, actual, "", 1, &mut found);
    found
}
