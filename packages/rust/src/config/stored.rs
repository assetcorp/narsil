use super::payload::restored_config_fields;
use super::restore_vector::restored_embedding;
use super::types::IndexConfig;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

fn without_nil(settings: &Map) -> Map {
    settings
        .iter()
        .filter(|(_, value)| !matches!(value, Value::Null))
        .map(|(key, value)| {
            let kept = match value {
                Value::Object(nested) => Value::Object(without_nil(nested)),
                other => other.clone(),
            };
            (key.clone(), kept)
        })
        .collect()
}

/// Returns the configuration of an index from its schema and from the settings that a store holds beside it,
/// reading each setting in the stored form that a snapshot, an export header, and a cluster coordinator share.
///
/// A tokenizer and a stop word set appear by their registered names, custom stop words appear under
/// `stopWordList`, and the partition limits appear under `partitionConfig`. The function takes the language from
/// `language` and the embedding settings from `embedding`, and it skips every key outside the stored form, so a
/// caller can pass a settings map that also holds keys for a separate purpose. A setting that holds nil, at any
/// depth, reads as one that is absent.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where a setting holds a value of the wrong shape, and the message names the setting.
pub fn index_config_from_stored_settings(schema: Value, settings: &Map) -> Result<IndexConfig> {
    let reject = |message: &str| NarsilError::new(ErrorCode::CONFIG_INVALID, message);
    let settings = &without_nil(settings);
    let mut config = restored_config_fields(settings, &reject)?;
    config.embedding = match settings.get("embedding") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(restored_embedding(raw, &reject)?),
    };
    config.language = match settings.get("language") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => Some(name.clone()),
        Some(_) => return Err(reject("language must be a name")),
    };
    config.schema = schema;
    Ok(config)
}
