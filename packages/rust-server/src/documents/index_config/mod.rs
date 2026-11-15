mod analysis;
mod bm25;
mod vectors;

use narsil::{
    ErrorCode, IndexConfig, Map, PartitionConfig, ScoringMode, Storage, Value,
    synonym_rules_from_json,
};

use super::constants::MAX_PARTITIONS;
use super::script_values::{saturating_count, script_text, script_truthy, whole_number};
use crate::errors::{Outcome, ServerError};

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
    config.tokenizer = analysis::tokenizer_of(http.get("tokenizer"))?;
    config.stop_words = analysis::stop_words_of(http.get("stopWords"))?;
    config.embedding = analysis::embedding_of(http.get("embedding"))?;
    config.language = http
        .get("language")
        .filter(|language| !language.is_null())
        .map(script_text);
    config.pattern_value_limit = http.get("patternValueLimit").map(pattern_value_limit_of);
    config.surface_forms = http
        .get("surfaceForms")
        .map(|surface| *surface == Value::Bool(true));
    config.vector_promotion = vectors::vector_promotion_of(http.get("vectorPromotion"))?;
    config.text_storage = text_storage_of(http.get("textStorage"))?;
    config.bm25 = http.get("bm25").map(bm25::bm25_of).transpose()?;
    config.partitions = http
        .get("partitions")
        .and_then(Value::as_object)
        .map(partitions_of)
        .transpose()?;
    config.strict = http
        .get("strict")
        .map(|strict| *strict == Value::Bool(true));
    config.required = http.get("required").and_then(required_of);
    config.track_positions = http
        .get("trackPositions")
        .filter(|track| !track.is_null())
        .map(script_truthy);
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

fn partitions_of(raw: &Map) -> Outcome<PartitionConfig> {
    let max_docs_per_partition = match raw.get("maxDocsPerPartition") {
        None => None,
        Some(count) => match whole_number(count).filter(|count| *count >= 1.0) {
            Some(count) => Some(saturating_count(count)),
            None => {
                return Err(config_refusal(
                    "partitions.maxDocsPerPartition must be a positive integer",
                    vec![("maxDocsPerPartition", count.clone())],
                ));
            }
        },
    };
    let max_partitions = match raw.get("maxPartitions") {
        None => None,
        Some(count) => {
            match whole_number(count).filter(|count| (1.0..=MAX_PARTITIONS).contains(count)) {
                Some(count) => Some(saturating_count(count)),
                None => {
                    return Err(config_refusal(
                        format!(
                            "partitions.maxPartitions must be an integer from 1 to {MAX_PARTITIONS}"
                        ),
                        vec![("maxPartitions", count.clone())],
                    ));
                }
            }
        }
    };
    let watermark = match raw.get("watermark") {
        None => None,
        Some(Value::Number(watermark)) if *watermark > 0.0 && *watermark <= 1.0 => Some(*watermark),
        Some(other) => {
            return Err(config_refusal(
                "partitions.watermark must be above 0 and at most 1",
                vec![("watermark", other.clone())],
            ));
        }
    };
    Ok(PartitionConfig {
        max_docs_per_partition,
        max_partitions,
        watermark,
    })
}
