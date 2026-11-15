#![allow(dead_code)]

use narsil::{Map, Value};

use crate::support::{Call, parsed, send};

pub const BODY_LIMIT_BYTES: usize = 4096;
pub const FETCH_LIMIT_DOCUMENTS: u64 = 3;
const OVERSIZED_PLACEHOLDER: &str = "PAD4096";
const GENERATED_ID: &str = "<generated id>";

pub struct Case {
    pub method: String,
    pub path: String,
    pub body: Option<String>,
}

pub fn cases(fixture: &str) -> Vec<Case> {
    fixture
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let Value::Object(case) = parsed(line) else {
                panic!("every fixture line is an object: {line}");
            };
            let text = |key: &str| match case.get(key) {
                Some(Value::String(value)) => value.clone(),
                _ => panic!("every fixture line sets {key}: {line}"),
            };
            let body = match (case.get("raw"), case.get("body")) {
                (Some(Value::String(raw)), _) => {
                    Some(raw.replace(OVERSIZED_PLACEHOLDER, &"x".repeat(BODY_LIMIT_BYTES)))
                }
                (_, Some(body)) => Some(narsil::write_plain_json(body)),
                _ => None,
            };
            Case {
                method: text("method"),
                path: text("path"),
                body,
            }
        })
        .collect()
}

pub fn call(case: &Case) -> Call<'_> {
    let call = Call::new(&case.method, &case.path);
    match &case.body {
        Some(body) => call
            .header("content-type", "application/json")
            .raw(body.clone()),
        None => call,
    }
}

fn is_generated_id(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length && group.chars().all(|c| c.is_ascii_hexdigit())
        })
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        _ => "string",
    }
}

pub fn comparable(value: &Value) -> Value {
    match value {
        Value::String(text) if is_generated_id(text) => Value::String(GENERATED_ID.to_string()),
        Value::Array(items) => Value::Array(items.iter().map(comparable).collect()),
        Value::Object(entries) => {
            let mut kept = Map::with_capacity(entries.len());
            for (key, entry) in entries.iter() {
                let entry = if key.ends_with("Bytes") {
                    Value::String(type_name(entry).to_string())
                } else {
                    comparable(entry)
                };
                kept.insert(key, entry);
            }
            Value::Object(kept)
        }
        other => other.clone(),
    }
}

fn is_error(entries: &Map) -> bool {
    matches!(entries.get("code"), Some(Value::String(_)))
        && matches!(entries.get("message"), Some(Value::String(_)))
}

pub fn without_engine_error_details(reference: &Value, rust: &Value) -> Value {
    match (reference, rust) {
        (Value::Array(theirs), Value::Array(mine)) => Value::Array(
            theirs
                .iter()
                .enumerate()
                .map(|(position, entry)| match mine.get(position) {
                    Some(counterpart) => without_engine_error_details(entry, counterpart),
                    None => entry.clone(),
                })
                .collect(),
        ),
        (Value::Object(theirs), Value::Object(mine)) => {
            let drop_details = is_error(theirs) && is_error(mine) && mine.get("details").is_none();
            let mut kept = Map::with_capacity(theirs.len());
            for (key, entry) in theirs.iter() {
                if drop_details && key == "details" {
                    continue;
                }
                let entry = match mine.get(key) {
                    Some(counterpart) => without_engine_error_details(entry, counterpart),
                    None => entry.clone(),
                };
                kept.insert(key, entry);
            }
            Value::Object(kept)
        }
        (theirs, _) => theirs.clone(),
    }
}

pub struct Divergence {
    pub line: usize,
    pub request: String,
    pub rust: String,
    pub reference: String,
}

pub async fn replay(rust: u16, reference: u16, fixture: &[Case]) -> Vec<Divergence> {
    let mut divergences = Vec::new();
    for (line, case) in fixture.iter().enumerate() {
        let request = call(case);
        let mine = send(rust, &request).await;
        let theirs = send(reference, &request).await;
        let request = format!(
            "{} {} {}",
            case.method,
            case.path,
            case.body.as_deref().unwrap_or("")
        );
        assert_eq!(
            (mine.status, mine.error_code()),
            (theirs.status, theirs.error_code()),
            "line {} {request} answers with the TypeScript status and code; Rust body {}, TypeScript body {}",
            line + 1,
            String::from_utf8_lossy(&mine.body),
            String::from_utf8_lossy(&theirs.body),
        );
        let rust_body = comparable(&mine.json());
        let reference_body =
            comparable(&without_engine_error_details(&theirs.json(), &mine.json()));
        if rust_body != reference_body {
            divergences.push(Divergence {
                line: line + 1,
                request,
                rust: String::from_utf8_lossy(&mine.body).into_owned(),
                reference: String::from_utf8_lossy(&theirs.body).into_owned(),
            });
        }
    }
    divergences
}

pub fn report(divergences: &[Divergence]) -> String {
    divergences
        .iter()
        .map(|divergence| {
            format!(
                "line {} {}\n  Rust       {}\n  TypeScript {}",
                divergence.line, divergence.request, divergence.rust, divergence.reference
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
