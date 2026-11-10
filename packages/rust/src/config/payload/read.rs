use std::collections::HashSet;

use super::{Rejection, object, string_list, whole_number};
use crate::analysis::StopWords;
use crate::config::restore_vector::restored_vector_promotion;
use crate::config::types::{
    Bm25FieldParams, Bm25Params, IndexConfig, PartitionConfig, ScoringMode, StopWordsSetting,
    Storage, TokenizerSetting,
};
use crate::config::validate::stored_max_partitions;
use crate::error::Result;
use crate::value::{Map, Value};

fn finite_number(
    value: Option<&Value>,
    message: &str,
    reject: Rejection<'_>,
) -> Result<Option<f64>> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) if number.is_finite() => Ok(Some(*number)),
        Some(_) => Err(reject(message)),
    }
}

fn restored_bm25_pair(raw: &Map, label: &str, reject: Rejection<'_>) -> Result<Bm25FieldParams> {
    Ok(Bm25FieldParams {
        k1: finite_number(
            raw.get("k1"),
            &format!("{label} k1 must be a finite number"),
            reject,
        )?,
        b: finite_number(
            raw.get("b"),
            &format!("{label} b must be a finite number"),
            reject,
        )?,
    })
}

pub(crate) fn restored_bm25(raw: &Value, reject: Rejection<'_>) -> Result<Bm25Params> {
    let raw = object(raw, "bm25 must be an object", reject)?;
    let pair = restored_bm25_pair(raw, "bm25", reject)?;
    let fields = match raw.get("fields") {
        None => None,
        Some(fields) => {
            let fields = object(fields, "bm25 fields must be an object", reject)?;
            let mut parsed = Vec::with_capacity(fields.len());
            for (name, entry) in fields.iter() {
                let entry = object(
                    entry,
                    "bm25 fields must map each field to an object",
                    reject,
                )?;
                parsed.push((
                    name.clone(),
                    restored_bm25_pair(entry, "bm25 field", reject)?,
                ));
            }
            Some(parsed)
        }
    };
    Ok(Bm25Params {
        k1: pair.k1,
        b: pair.b,
        fields,
    })
}

pub(crate) fn restored_partition_config(
    raw: &Value,
    reject: Rejection<'_>,
) -> Result<PartitionConfig> {
    let raw = object(raw, "partitionConfig must be an object", reject)?;
    let watermark = match raw.get("watermark") {
        None => None,
        Some(Value::Number(watermark)) if *watermark > 0.0 && *watermark <= 1.0 => Some(*watermark),
        Some(_) => {
            return Err(reject(
                "partitionConfig watermark must be above 0 and at most 1",
            ));
        }
    };
    Ok(PartitionConfig {
        max_docs_per_partition: whole_number(
            raw.get("maxDocsPerPartition"),
            "partitionConfig maxDocsPerPartition must be a positive integer",
            reject,
        )?,
        max_partitions: stored_max_partitions(whole_number(
            raw.get("maxPartitions"),
            "partitionConfig maxPartitions must be a positive integer",
            reject,
        )?),
        watermark,
    })
}

fn boolean(value: Option<&Value>, field: &str, reject: Rejection<'_>) -> Result<Option<bool>> {
    match value {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(reject(&format!("{field} must be a boolean"))),
    }
}

/// Reads every setting of a stored configuration beside its schema, language, and embedding.
pub(crate) fn restored_config_fields(payload: &Map, reject: Rejection<'_>) -> Result<IndexConfig> {
    let mut config = IndexConfig::default();
    match payload.get("tokenizer") {
        None => {}
        Some(Value::String(name)) => config.tokenizer = Some(TokenizerSetting::Named(name.clone())),
        Some(_) => return Err(reject("tokenizer must be a name")),
    }
    let stop_name = payload.get("stopWords");
    let stop_list = payload.get("stopWordList");
    if stop_name.is_some_and(|name| !matches!(name, Value::String(_))) {
        return Err(reject("stopWords must be a name"));
    }
    let list = match stop_list {
        None => None,
        Some(list) => {
            Some(string_list(list).ok_or_else(|| reject("stopWordList must be a list of words"))?)
        }
    };
    match (stop_name, list) {
        (Some(_), Some(_)) => {
            return Err(reject("stopWords and stopWordList cannot both be present"));
        }
        (Some(Value::String(name)), None) => {
            config.stop_words = Some(StopWordsSetting::Named(name.clone()))
        }
        (None, Some(words)) => {
            let set: HashSet<String> = words.into_iter().collect();
            config.stop_words = Some(StopWordsSetting::Words(StopWords::Set(set)));
        }
        _ => {}
    }
    if let Some(bm25) = payload.get("bm25") {
        config.bm25 = Some(restored_bm25(bm25, reject)?);
    }
    config.surface_forms = boolean(payload.get("surfaceForms"), "surfaceForms", reject)?;
    match payload.get("defaultScoring") {
        None => {}
        Some(Value::String(name)) if ScoringMode::parse(name).is_some() => {
            config.default_scoring = ScoringMode::parse(name);
        }
        Some(_) => {
            return Err(reject(
                "defaultScoring must be 'local', 'dfs', or 'broadcast'",
            ));
        }
    }
    config.track_positions = boolean(payload.get("trackPositions"), "trackPositions", reject)?;
    match payload.get("textStorage") {
        None => {}
        Some(Value::String(name)) if Storage::parse(name).is_some() => {
            config.text_storage = Storage::parse(name)
        }
        Some(_) => return Err(reject("textStorage must be 'memory' or 'disk'")),
    }
    config.strict = boolean(payload.get("strict"), "strict", reject)?;
    if let Some(required) = payload.get("required") {
        config.required = Some(
            string_list(required)
                .ok_or_else(|| reject("required must be a list of field paths"))?,
        );
    }
    if let Some(promotion) = payload.get("vectorPromotion") {
        config.vector_promotion = Some(restored_vector_promotion(promotion, reject)?);
    }
    match payload.get("patternValueLimit") {
        None => {}
        Some(Value::Number(limit))
            if limit.fract() == 0.0 && *limit >= 0.0 && *limit <= u64::MAX as f64 =>
        {
            config.pattern_value_limit = Some(*limit as u64);
        }
        Some(Value::Number(_)) => {
            crate::config::validate::validate_pattern_value_limit(Some(0))?;
        }
        Some(_) => return Err(reject("patternValueLimit must be a number")),
    }
    if let Some(partitions) = payload.get("partitionConfig") {
        config.partitions = Some(restored_partition_config(partitions, reject)?);
    }
    Ok(config)
}
