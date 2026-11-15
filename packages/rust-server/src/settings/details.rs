use narsil::Value;

use super::js_text::displayed_name;
use crate::errors::ServerError;

const CONFIG_INVALID: &str = "CONFIG_INVALID";
const PARTITION_CAPACITY_EXCEEDED: &str = "PARTITION_CAPACITY_EXCEEDED";
const ENGINE_DISPLAYED_NAME_CHARS: usize = 64;
const PHRASE_REASON_SUFFIX: &str = " tokens, as a phrase does";
const STOP_WORD_REASON: &str = "to no token, as a stop word does";

fn count_of(text: &str) -> Option<Value> {
    (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse::<f64>().ok())
        .flatten()
        .map(Value::Number)
}

fn bracketed_pair(message: &str, before: &str, between: &str) -> Option<(Value, Value)> {
    let rest = message.strip_prefix(before)?.strip_suffix(')')?;
    let (first, second) = rest.split_once(between)?;
    Some((count_of(first)?, count_of(second)?))
}

pub(crate) fn with_capacity_details(failure: ServerError) -> ServerError {
    if failure.code != PARTITION_CAPACITY_EXCEEDED || failure.details.is_some() {
        return failure;
    }
    let shapes = [
        (
            "maxPartitions (",
            ") is less than the current partition count (",
            "maxPartitions",
            "partitionCount",
        ),
        (
            "New capacity (",
            ") is less than current document count (",
            "newTotalCapacity",
            "currentDocCount",
        ),
    ];
    for (before, between, first_key, second_key) in shapes {
        if let Some((first, second)) = bracketed_pair(&failure.message, before, between) {
            return failure
                .with_detail(first_key, first)
                .with_detail(second_key, second);
        }
    }
    failure
}

pub(crate) fn with_synonym_details(failure: ServerError) -> ServerError {
    if failure.code != CONFIG_INVALID || failure.details.is_some() {
        return failure;
    }
    let Some(rest) = failure.message.strip_prefix("Synonym rule ") else {
        return failure;
    };
    let Some((rule, reason)) = rest.split_once(" holds a word that the index analyses ") else {
        return failure;
    };
    let tokens = if reason == STOP_WORD_REASON {
        Some(Value::Number(0.0))
    } else {
        reason
            .strip_prefix("to ")
            .and_then(|reason| reason.strip_suffix(PHRASE_REASON_SUFFIX))
            .and_then(count_of)
    };
    match (count_of(rule), tokens) {
        (Some(rule), Some(tokens)) => failure
            .with_detail("rule", rule)
            .with_detail("tokens", tokens),
        _ => failure,
    }
}

fn engine_shown(name: &str) -> String {
    name.chars().take(ENGINE_DISPLAYED_NAME_CHARS).collect()
}

fn names_the_field(message: &str, name: &str) -> bool {
    let shown = engine_shown(name);
    message
        == format!(
            "BM25 parameters apply to a text field that the schema declares, and the schema declares no field \"{shown}\""
        )
        || message.starts_with(&format!(
            "BM25 parameters apply to a text field alone, and the schema declares field \"{shown}\" as \""
        ))
}

pub(crate) fn with_bm25_field_details<'a>(
    failure: ServerError,
    names: impl IntoIterator<Item = &'a str>,
) -> ServerError {
    if failure.code != CONFIG_INVALID || failure.details.is_some() {
        return failure;
    }
    match names
        .into_iter()
        .find(|name| names_the_field(&failure.message, name))
    {
        Some(name) => {
            let shown = displayed_name(name).to_string();
            failure.with_detail("field", Value::String(shown))
        }
        None => failure,
    }
}
