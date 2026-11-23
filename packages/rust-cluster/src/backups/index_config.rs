use narsil::replication::{
    BackupConstraints, decode_backup_index_configuration, require_restorable_config,
};
use narsil::{
    IndexConfig, Map, Value, encode_msgpack, index_config_from_stored_settings,
    synonym_rules_from_json,
};

use super::manifest::constraints_wire;
use super::synonym_store::{delete_synonym_set, store_synonym_set};
use crate::controller::{metadata_key, stored_settings_readable, validate_index_name};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

const STORED_SETTING_KEYS: [&str; 15] = [
    "tokenizer",
    "stopWords",
    "stopWordList",
    "bm25",
    "surfaceForms",
    "defaultScoring",
    "trackPositions",
    "textStorage",
    "strict",
    "returnVectors",
    "required",
    "vectorPromotion",
    "patternValueLimit",
    "partitionConfig",
    "embedding",
];
const PARTITION_LIMIT_KEYS: [&str; 2] = ["maxDocsPerPartition", "watermark"];
const SUGGESTION_KEYS: [&str; 3] = [
    "querySuggestions",
    "bannedQueries",
    "querySuggestionsSource",
];
const DEFAULT_LANGUAGE: &str = "english";
const FIRST_BM25_REVISION: u64 = 1;

pub(crate) struct RestorableConfig {
    pub(crate) schema: Value,
    config: IndexConfig,
    pub(crate) settings: Map,
    pub(crate) synonyms: Option<Value>,
    pub(crate) suggestions: Map,
}

pub(crate) struct RestoredIndexShape<'s> {
    pub(crate) index_name: &'s str,
    pub(crate) index_uuid: &'s str,
    pub(crate) partition_count: u64,
    pub(crate) replication_factor: f64,
    pub(crate) constraints: &'s BackupConstraints,
}

fn damaged_config(backup_name: &str, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::BACKUP_DAMAGED,
        format!("The index configuration of backup '{backup_name}' is invalid: {reason}"),
    )
    .with_detail("backupName", Value::from(backup_name))
}

fn is_nil(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn place_stored_field(nested: &mut Map, path: &str, kind: Value) -> Result<(), String> {
    let conflicting = |at: &str| {
        format!("Field path \"{at}\" is declared both as a field and as an object of fields")
    };
    let segments: Vec<&str> = path.split('.').collect();
    let mut level = nested;
    for (at, segment) in segments.iter().enumerate() {
        if at + 1 == segments.len() {
            if level.get(segment).is_some() {
                return Err(conflicting(path));
            }
            level.insert(*segment, kind);
            return Ok(());
        }
        if level.get(segment).is_none() {
            level.insert(*segment, Value::Object(Map::new()));
        }
        level = match level.get_mut(segment) {
            Some(Value::Object(child)) => child,
            _ => return Err(conflicting(&segments[..=at].join("."))),
        };
    }
    Ok(())
}

fn place_stored_fields(nested: &mut Map, stored: &Map, prefix: &str) -> Result<(), String> {
    for (key, kind) in stored.iter() {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match kind {
            Value::Object(inner) => place_stored_fields(nested, inner, &path)?,
            other => place_stored_field(nested, &path, other.clone())?,
        }
    }
    Ok(())
}

fn nested_schema_of(stored: &Value) -> Result<Value, String> {
    let Value::Object(fields) = stored else {
        return Ok(stored.clone());
    };
    let mut nested = Map::new();
    place_stored_fields(&mut nested, fields, "")?;
    Ok(Value::Object(nested))
}

fn partition_limits_of(raw: &Value) -> Option<Value> {
    let fields = raw.as_object()?;
    let mut limits = Map::new();
    for key in PARTITION_LIMIT_KEYS {
        if let Some(value) = fields
            .get(key)
            .filter(|value| !matches!(value, Value::Null))
        {
            limits.insert(key, value.clone());
        }
    }
    (!limits.is_empty()).then_some(Value::Object(limits))
}

fn settings_of(envelope: &Map) -> Result<Map, String> {
    let mut settings = Map::new();
    let language = match envelope.get("language") {
        None | Some(Value::Null) => DEFAULT_LANGUAGE.to_string(),
        Some(Value::String(language)) if !language.is_empty() => language.clone(),
        Some(_) => return Err("language must be a name".to_string()),
    };
    settings.insert("language", Value::String(language));
    for key in STORED_SETTING_KEYS {
        let Some(value) = envelope
            .get(key)
            .filter(|value| !matches!(value, Value::Null))
        else {
            continue;
        };
        if key == "partitionConfig" {
            if let Some(limits) = partition_limits_of(value) {
                settings.insert(key, limits);
            }
            continue;
        }
        settings.insert(key, value.clone());
    }
    Ok(settings)
}

pub(crate) fn decode_backup_index_config(
    bytes: &[u8],
    backup_name: &str,
) -> ClusterResult<RestorableConfig> {
    let reject = |reason: &str| damaged_config(backup_name, reason);
    let envelope =
        decode_backup_index_configuration(bytes).map_err(|error| reject(error.message()))?;
    let schema = nested_schema_of(envelope.get("schema").unwrap_or(&Value::Null))
        .map_err(|reason| reject(&reason))?;
    let settings = settings_of(&envelope).map_err(|reason| reject(&reason))?;
    let synonyms = match envelope.get("synonyms") {
        None | Some(Value::Null) => None,
        Some(rules @ Value::Array(_)) => Some(rules.clone()),
        Some(_) => return Err(reject("synonyms must be a list")),
    };
    let mut config = index_config_from_stored_settings(schema.clone(), &settings)
        .map_err(|error| reject(error.message()))?;
    if let Some(rules) = &synonyms {
        config.synonyms =
            Some(synonym_rules_from_json(rules).map_err(|error| reject(error.message()))?);
    }
    let mut suggestions = Map::new();
    for key in SUGGESTION_KEYS {
        if let Some(value) = envelope
            .get(key)
            .filter(|value| !matches!(value, Value::Null))
        {
            if key == "bannedQueries" && matches!(value, Value::Array(banned) if banned.is_empty())
            {
                continue;
            }
            suggestions.insert(key, value.clone());
        }
    }
    Ok(RestorableConfig {
        schema,
        config,
        settings,
        synonyms,
        suggestions,
    })
}

fn sets_bm25_field_values(settings: &Map) -> bool {
    let Some(Value::Object(fields)) = settings
        .get("bm25")
        .and_then(Value::as_object)
        .and_then(|bm25| bm25.get("fields"))
    else {
        return false;
    };
    fields.iter().any(|(_, pair)| match pair {
        Value::Object(pair) => !is_nil(pair.get("k1")) || !is_nil(pair.get("b")),
        _ => true,
    })
}

fn metadata_of(
    restorable: &RestorableConfig,
    shape: &RestoredIndexShape<'_>,
    synonyms: Option<&Value>,
    suggestions: bool,
) -> Value {
    let mut settings = restorable.settings.clone();
    if let Some(reference) = synonyms {
        settings.insert("synonyms", reference.clone());
    }
    if sets_bm25_field_values(&restorable.settings) {
        settings.insert("bm25Revision", Value::from(FIRST_BM25_REVISION));
    }
    if suggestions {
        for (key, value) in restorable.suggestions.iter() {
            settings.insert(key.as_str(), value.clone());
        }
    }
    let mut metadata = Map::with_capacity(6);
    metadata.insert("indexUuid", Value::from(shape.index_uuid));
    metadata.insert("indexName", Value::from(shape.index_name));
    metadata.insert("partitionCount", Value::from(shape.partition_count));
    metadata.insert("replicationFactor", Value::Number(shape.replication_factor));
    metadata.insert("constraints", constraints_wire(shape.constraints));
    metadata.insert("settings", Value::Object(settings));
    Value::Object(metadata)
}

async fn put_index_metadata(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    bytes: &[u8],
) -> ClusterResult<bool> {
    validate_index_name(index_name)?;
    let key = metadata_key(index_name);
    if coordinator.compare_and_set(&key, None, bytes).await? {
        return Ok(true);
    }
    match coordinator.get(&key).await? {
        Some(current) if current.is_empty() => {
            coordinator
                .compare_and_set(&key, Some(&current), bytes)
                .await
        }
        _ => Ok(false),
    }
}

pub(crate) async fn write_restored_metadata(
    coordinator: &EtcdCoordinator,
    restorable: &RestorableConfig,
    shape: &RestoredIndexShape<'_>,
    with_suggestions: bool,
) -> ClusterResult<bool> {
    require_restorable_config(&restorable.config)?;
    let synonym_set = match &restorable.synonyms {
        Some(rules) if matches!(rules, Value::Array(list) if !list.is_empty()) => {
            Some(store_synonym_set(coordinator, shape.index_uuid, rules).await?)
        }
        _ => None,
    };
    let metadata = metadata_of(
        restorable,
        shape,
        synonym_set.as_ref().map(|set| &set.reference),
        with_suggestions,
    );
    let readable = metadata
        .as_object()
        .and_then(|fields| fields.get("settings"))
        .and_then(Value::as_object)
        .is_some_and(stored_settings_readable);
    let stored = match encode_msgpack(&metadata) {
        Ok(bytes) if readable => put_index_metadata(coordinator, shape.index_name, &bytes).await,
        Ok(_) => Err(ClusterError::new(
            codes::BACKUP_DAMAGED,
            format!(
                "The index configuration restored for '{}' holds a setting of the wrong shape",
                shape.index_name
            ),
        )),
        Err(error) => Err(error.into()),
    };
    if let Some(set) = &synonym_set
        && !matches!(stored, Ok(true))
    {
        let _ = delete_synonym_set(coordinator, shape.index_uuid, set).await;
    }
    stored
}
