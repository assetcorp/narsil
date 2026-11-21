mod analysis;
mod given_values;
mod vectors;

pub(crate) use given_values::with_given_values;

use narsil::{ErrorCode, IndexConfig, Map, ScoringMode, Storage, Value, synonym_rules_from_json};

use crate::errors::{Outcome, ServerError};
use crate::script_values::{saturating_count, script_text, script_type_name, whole_number};
use crate::settings::{bm25_params_of, partitions_of};

pub(crate) fn refusal(
    code: ErrorCode,
    message: impl Into<String>,
    details: Vec<(&str, Value)>,
) -> ServerError {
    let mut map = Map::with_capacity(details.len());
    for (key, value) in details {
        map.insert(key, value);
    }
    ServerError::coded(code.as_str(), message).with_details(map)
}

pub(crate) fn config_refusal(
    message: impl Into<String>,
    details: Vec<(&str, Value)>,
) -> ServerError {
    refusal(ErrorCode::CONFIG_INVALID, message, details)
}

pub(crate) fn index_config_of(http: &Map) -> Outcome<IndexConfig> {
    let schema = match http.get("schema") {
        Some(schema @ Value::Object(_)) => schema.clone(),
        _ => {
            return Err(config_refusal(
                "Index config requires a \"schema\" object",
                Vec::new(),
            ));
        }
    };
    let mut config = IndexConfig::new(schema);
    config.return_vectors = flag_of("returnVectors", http.get("returnVectors"))?;
    config.strict = flag_of("strict", http.get("strict"))?;
    config.surface_forms = flag_of("surfaceForms", http.get("surfaceForms"))?;
    config.track_positions = flag_of("trackPositions", http.get("trackPositions"))?;
    config.tokenizer = analysis::tokenizer_of(http.get("tokenizer"))?;
    config.stop_words = analysis::stop_words_of(http.get("stopWords"))?;
    config.embedding = analysis::embedding_of(http.get("embedding"))?;
    config.language = http
        .get("language")
        .filter(|language| !language.is_null())
        .map(script_text);
    config.pattern_value_limit = http.get("patternValueLimit").map(pattern_value_limit_of);
    config.vector_promotion = vectors::vector_promotion_of(http.get("vectorPromotion"))?;
    config.text_storage = text_storage_of(http.get("textStorage"))?;
    config.bm25 = http.get("bm25").map(bm25_params_of).transpose()?;
    config.partitions = http
        .get("partitions")
        .and_then(Value::as_object)
        .map(partitions_of)
        .transpose()?;
    config.required = http.get("required").and_then(required_of);
    config.default_scoring = http
        .get("defaultScoring")
        .and_then(Value::as_str)
        .and_then(scoring_of);
    config.synonyms = http
        .get("synonyms")
        .map(synonym_rules_from_json)
        .transpose()
        .map_err(ServerError::from)?;
    Ok(config)
}

fn scoring_of(name: &str) -> Option<ScoringMode> {
    match name {
        "local" => Some(ScoringMode::Local),
        "dfs" => Some(ScoringMode::Dfs),
        "broadcast" => Some(ScoringMode::Broadcast),
        _ => None,
    }
}

fn pattern_value_limit_of(limit: &Value) -> u64 {
    whole_number(limit).map_or(0, saturating_count)
}

fn flag_of(field: &str, given: Option<&Value>) -> Outcome<Option<bool>> {
    match given {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(other) => Err(config_refusal(
            format!("{field} must be true or false"),
            vec![(
                field,
                Value::String(
                    if other.is_null() {
                        "null"
                    } else {
                        script_type_name(other)
                    }
                    .to_string(),
                ),
            )],
        )),
    }
}

fn text_storage_of(storage: Option<&Value>) -> Outcome<Option<Storage>> {
    match storage {
        None => Ok(None),
        Some(Value::String(name)) if name == "memory" => Ok(Some(Storage::Memory)),
        Some(Value::String(name)) if name == "disk" => Ok(Some(Storage::Disk)),
        Some(other) => Err(config_refusal(
            "textStorage must be 'memory', or 'disk' with filesystem durability",
            vec![("textStorage", other.clone())],
        )),
    }
}

fn required_of(required: &Value) -> Option<Vec<String>> {
    match required {
        Value::Array(fields) if !fields.is_empty() => {
            Some(fields.iter().map(script_text).collect())
        }
        Value::String(fields) if !fields.is_empty() => {
            Some(fields.chars().map(String::from).collect())
        }
        _ => None,
    }
}
