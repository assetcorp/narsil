use std::collections::HashSet;

use narsil::{
    AdapterSetting, EmbeddingConfig, ErrorCode, Map, StopWords, StopWordsSetting, TokenizerSetting,
    Value,
};

use super::{config_refusal, refusal};
use crate::documents::script_values::script_text;
use crate::errors::{Outcome, ServerError};

pub(super) fn tokenizer_of(tokenizer: Option<&Value>) -> Outcome<Option<TokenizerSetting>> {
    match tokenizer {
        None => Ok(None),
        Some(Value::String(name)) => Ok(Some(TokenizerSetting::Named(name.clone()))),
        Some(_) => Err(config_refusal(
            "Field \"tokenizer\" must be a registered name",
            Vec::new(),
        )),
    }
}

pub(super) fn stop_words_of(stop_words: Option<&Value>) -> Outcome<Option<StopWordsSetting>> {
    match stop_words {
        None => Ok(None),
        Some(Value::String(name)) => Ok(Some(StopWordsSetting::Named(name.clone()))),
        Some(Value::Array(words)) => {
            let mut set = HashSet::with_capacity(words.len());
            for word in words {
                let Value::String(word) = word else {
                    return Err(stop_words_refusal());
                };
                set.insert(word.clone());
            }
            Ok(Some(StopWordsSetting::Words(StopWords::Set(set))))
        }
        Some(_) => Err(stop_words_refusal()),
    }
}

fn stop_words_refusal() -> ServerError {
    config_refusal(
        "Field \"stopWords\" must be a registered name or an array of strings",
        Vec::new(),
    )
}

fn embedding_refusal(message: &str) -> ServerError {
    refusal(ErrorCode::EMBEDDING_CONFIG_INVALID, message, Vec::new())
}

fn sources_of(sources: &Value) -> Vec<String> {
    match sources {
        Value::Array(sources) => sources.iter().map(script_text).collect(),
        other => vec![script_text(other)],
    }
}

fn mapped_fields(fields: &Value) -> Vec<(String, Vec<String>)> {
    match fields {
        Value::Object(fields) => fields
            .iter()
            .map(|(target, sources)| (target.clone(), sources_of(sources)))
            .collect(),
        Value::Array(fields) => fields
            .iter()
            .enumerate()
            .map(|(at, sources)| (at.to_string(), sources_of(sources)))
            .collect(),
        _ => Vec::new(),
    }
}

pub(super) fn embedding_of(embedding: Option<&Value>) -> Outcome<Option<EmbeddingConfig>> {
    let empty = Map::new();
    let embedding = match embedding {
        None => return Ok(None),
        Some(Value::Object(embedding)) => embedding,
        Some(Value::Array(_)) => &empty,
        Some(_) => return Err(embedding_refusal("Field \"embedding\" must be an object")),
    };
    let fields = match embedding.get("fields") {
        Some(fields @ (Value::Object(_) | Value::Array(_))) => fields,
        _ => return Err(embedding_refusal("Field \"embedding.fields\" is required")),
    };
    let adapter = match embedding.get("adapter") {
        None => None,
        Some(Value::String(name)) if !name.is_empty() => Some(AdapterSetting::Named(name.clone())),
        Some(_) => {
            return Err(embedding_refusal(
                "Field \"embedding.adapter\" must be a non-empty adapter name",
            ));
        }
    };
    Ok(Some(EmbeddingConfig {
        fields: mapped_fields(fields),
        adapter,
    }))
}
