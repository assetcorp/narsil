use narsil::{Map, Value, decode_msgpack};

use crate::allocator::Constraints;
use crate::constants::{
    DEFAULT_ZONE_ATTRIBUTE, INDEX_METADATA_KEY_PREFIX, INDEX_METADATA_KEY_SUFFIX,
    MAX_DISPLAYED_VALUE_CHARS, MAX_INDEX_NAME_LENGTH, MAX_INDEX_UUID_LENGTH, MAX_PARTITION_COUNT,
    MAX_REPLICATION_FACTOR, MAX_SAFE_INTEGER, REBALANCE_RECORD_KEY_SUFFIX, SYNC_EPOCH_HEX_DIGITS,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

const REBALANCE_PHASES: [&str; 3] = ["copying", "cutover", "aborting"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct IndexMetadata {
    pub(crate) index_uuid: String,
    pub(crate) partition_count: f64,
    pub(crate) replication_factor: f64,
    pub(crate) constraints: Constraints,
}

fn displayed(text: &str) -> String {
    if text.chars().count() <= MAX_DISPLAYED_VALUE_CHARS {
        return text.to_string();
    }
    let shortened: String = text.chars().take(MAX_DISPLAYED_VALUE_CHARS).collect();
    format!("{shortened}...")
}

fn metadata_invalid(index_name: &str, message: String) -> ClusterError {
    ClusterError::new(codes::CONTROLLER_METADATA_INVALID, message)
        .with_detail("indexName", Value::String(displayed(index_name)))
}

pub(crate) fn validate_index_name(index_name: &str) -> ClusterResult<()> {
    let length = index_name.encode_utf16().count();
    if length == 0 || length > MAX_INDEX_NAME_LENGTH {
        return Err(metadata_invalid(
            index_name,
            format!("Index name must be between 1 and {MAX_INDEX_NAME_LENGTH} characters"),
        ));
    }
    if index_name.contains('\0')
        || index_name.contains('/')
        || index_name.contains('\\')
        || index_name.contains("..")
    {
        return Err(metadata_invalid(
            index_name,
            "Index name contains forbidden characters (/, \\, .., or null bytes)".to_string(),
        ));
    }
    let mut characters = index_name.chars();
    let starts_well = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric());
    let continues_well = characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'));
    if !starts_well || !continues_well {
        return Err(metadata_invalid(
            index_name,
            "Index name must start with an alphanumeric character and contain only alphanumeric characters, hyphens, underscores, or dots".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn metadata_key(index_name: &str) -> String {
    format!("{INDEX_METADATA_KEY_PREFIX}{index_name}{INDEX_METADATA_KEY_SUFFIX}")
}

pub(crate) fn rebalance_record_key(index_name: &str) -> String {
    format!("{INDEX_METADATA_KEY_PREFIX}{index_name}{REBALANCE_RECORD_KEY_SUFFIX}")
}

fn whole_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

fn validate_record(decoded: &Value, index_name: &str) -> ClusterResult<IndexMetadata> {
    let Value::Object(record) = decoded else {
        return Err(metadata_invalid(
            index_name,
            format!("Index metadata for '{index_name}' is not an object"),
        ));
    };
    let index_uuid = match record.get("indexUuid") {
        Some(Value::String(uuid))
            if !uuid.is_empty() && uuid.encode_utf16().count() <= MAX_INDEX_UUID_LENGTH =>
        {
            uuid.clone()
        }
        _ => {
            return Err(metadata_invalid(
                index_name,
                format!("Index metadata for '{index_name}' has invalid indexUuid"),
            ));
        }
    };
    if !matches!(record.get("indexName"), Some(Value::String(_))) {
        return Err(metadata_invalid(
            index_name,
            format!("Index metadata for '{index_name}' has invalid indexName"),
        ));
    }
    let Some(partition_count) = whole_number(record.get("partitionCount"))
        .filter(|count| *count > 0.0 && *count <= MAX_PARTITION_COUNT)
    else {
        return Err(metadata_invalid(
            index_name,
            format!(
                "Index metadata for '{index_name}' has invalid partitionCount (must be an integer between 1 and {MAX_PARTITION_COUNT})"
            ),
        ));
    };
    let Some(replication_factor) = whole_number(record.get("replicationFactor"))
        .filter(|factor| *factor >= 0.0 && *factor <= MAX_REPLICATION_FACTOR)
    else {
        return Err(metadata_invalid(
            index_name,
            format!(
                "Index metadata for '{index_name}' has invalid replicationFactor (must be an integer between 0 and {MAX_REPLICATION_FACTOR})"
            ),
        ));
    };
    let Some(Value::Object(constraints)) = record.get("constraints") else {
        return Err(metadata_invalid(
            index_name,
            format!("Index metadata for '{index_name}' has invalid constraints"),
        ));
    };
    let max_shards_per_node = match constraints.get("maxShardsPerNode") {
        None | Some(Value::Null) => None,
        Some(Value::Number(limit)) => Some(*limit),
        Some(_) => {
            return Err(metadata_invalid(
                index_name,
                format!(
                    "Index metadata for '{index_name}' has invalid maxShardsPerNode (must be a number or null)"
                ),
            ));
        }
    };
    Ok(IndexMetadata {
        index_uuid,
        partition_count,
        replication_factor,
        constraints: Constraints {
            zone_awareness: matches!(constraints.get("zoneAwareness"), Some(Value::Bool(true))),
            zone_attribute: constraints
                .get("zoneAttribute")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_ZONE_ATTRIBUTE)
                .to_string(),
            max_shards_per_node,
        },
    })
}

async fn read_stored(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<(IndexMetadata, Option<Value>)>> {
    validate_index_name(index_name)?;
    let Some(raw) = coordinator.get(&metadata_key(index_name)).await? else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let decoded = decode_msgpack(&raw).map_err(ClusterError::from)?;
    let record = validate_record(&decoded, index_name)?;
    let settings = match decoded {
        Value::Object(mut fields) => fields.remove("settings"),
        _ => None,
    };
    Ok(Some((record, settings)))
}

pub(crate) async fn index_metadata(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<IndexMetadata>> {
    Ok(read_stored(coordinator, index_name)
        .await?
        .map(|(record, _)| record))
}

pub(crate) async fn records_previous_documents(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> bool {
    match read_stored(coordinator, index_name).await {
        Ok(None) => false,
        Ok(Some((_, settings))) => super::settings::previous_documents_recorded(settings.as_ref()),
        Err(_) => true,
    }
}

fn is_count(value: Option<&Value>) -> bool {
    whole_number(value).is_some_and(|count| count >= 0.0)
}

fn malformed(key: &str) -> ClusterError {
    ClusterError::new(
        codes::CONTROLLER_METADATA_INVALID,
        format!("The value stored under '{key}' is malformed"),
    )
    .with_detail("key", Value::String(key.to_string()))
}

fn record_text<'r>(record: &'r Map, field: &str) -> Option<&'r str> {
    record.get(field).and_then(Value::as_str)
}

pub(crate) async fn rebalance_generations(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<(String, String)>> {
    let key = rebalance_record_key(index_name);
    let Some(bytes) = coordinator.get(&key).await? else {
        return Ok(None);
    };
    if bytes.is_empty() {
        return Ok(None);
    }
    let Ok(Value::Object(record)) = decode_msgpack(&bytes) else {
        return Err(malformed(&key));
    };
    let well_formed = record_text(&record, "jobId").is_some()
        && is_count(record.get("targetPartitionCount"))
        && record_text(&record, "phase").is_some_and(|phase| REBALANCE_PHASES.contains(&phase))
        && is_count(record.get("cutoverAttempts"));
    match (
        record_text(&record, "sourceGeneration"),
        record_text(&record, "targetGeneration"),
    ) {
        (Some(source), Some(target)) if well_formed => {
            Ok(Some((source.to_string(), target.to_string())))
        }
        _ => Err(malformed(&key)),
    }
}

pub(crate) fn is_safe_count(value: &Value) -> bool {
    matches!(value, Value::Number(number) if number.fract() == 0.0 && *number >= 0.0 && *number <= MAX_SAFE_INTEGER as f64)
}

pub(crate) fn is_sync_epoch(value: &Value) -> bool {
    matches!(value, Value::String(epoch) if epoch.len() == SYNC_EPOCH_HEX_DIGITS
        && epoch.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}
