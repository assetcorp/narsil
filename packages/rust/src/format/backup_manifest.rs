use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, Expectation, MAX_FILE_BYTES, open_checksummed, pack};
use crate::format::metadata_parts::is_sync_epoch;
use crate::value::{Map, Value, decode_value, encode_value};

pub(crate) const BACKUP_MANIFEST_ENVELOPE_VERSION: u8 = 1;
const MAX_PARTITION_COUNT: f64 = 65_536.0;
const MAX_REPLICATION_FACTOR: f64 = 255.0;
const MAX_BACKUP_FILES_PER_PARTITION: usize = 1_000_000;
const MAX_BACKUP_HISTORY_FILES: usize = 1_000_000;
const MAX_BACKUP_FILE_PATH_LENGTH: usize = 1_024;
const MAX_HISTORY_FILE_BYTES: u64 = 16_777_216;
const SHA256_HEX_DIGITS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StoredFile {
    pub(crate) sha256: String,
    pub(crate) bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ListedFile {
    pub(crate) key: String,
    pub(crate) file: StoredFile,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BackupPartition {
    pub(crate) partition_id: u64,
    pub(crate) last_seq_no: f64,
    pub(crate) manifest: StoredFile,
    pub(crate) files: Vec<ListedFile>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AllocationConstraints {
    pub(crate) zone_awareness: bool,
    pub(crate) zone_attribute: String,
    pub(crate) max_shards_per_node: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BackupManifest {
    pub(crate) name: String,
    pub(crate) cluster_uuid: String,
    pub(crate) index_name: String,
    pub(crate) started_at: f64,
    pub(crate) completed_at: f64,
    pub(crate) partition_count: u64,
    pub(crate) sync_epoch: Option<String>,
    pub(crate) taken_by: Option<String>,
    pub(crate) replication_factor: f64,
    pub(crate) constraints: AllocationConstraints,
    pub(crate) config: StoredFile,
    pub(crate) query_history: Option<Vec<StoredFile>>,
    pub(crate) partitions: Vec<BackupPartition>,
}

fn damaged(backup_name: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::BACKUP_DAMAGED,
        format!("The manifest of backup '{backup_name}' {reason}"),
    )
}

fn integer(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

fn count(value: Option<&Value>) -> Option<f64> {
    integer(value).filter(|number| *number >= 0.0)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == SHA256_HEX_DIGITS
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_path_segment(segment: &str) -> bool {
    let mut bytes = segment.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn is_safe_file_key(key: &str) -> bool {
    key.encode_utf16().count() <= MAX_BACKUP_FILE_PATH_LENGTH && key.split('/').all(is_path_segment)
}

fn stored_file(value: Option<&Value>, backup_name: &str) -> Result<StoredFile> {
    let map = value.and_then(Value::as_object);
    let sha256 = map
        .and_then(|map| map.get("sha256"))
        .and_then(Value::as_str)
        .filter(|digest| is_sha256_hex(digest));
    let bytes = map
        .and_then(|map| count(map.get("bytes")))
        .filter(|bytes| *bytes <= MAX_FILE_BYTES as f64);
    match (sha256, bytes) {
        (Some(sha256), Some(bytes)) => Ok(StoredFile {
            sha256: sha256.to_string(),
            bytes: bytes as u64,
        }),
        _ => Err(damaged(
            backup_name,
            "lists a file without a valid SHA-256 digest and length",
        )),
    }
}

fn listed_file(value: &Value, backup_name: &str) -> Result<ListedFile> {
    let file = stored_file(Some(value), backup_name)?;
    match value
        .as_object()
        .and_then(|map| map.get("key"))
        .and_then(Value::as_str)
    {
        Some(key) if is_safe_file_key(key) => Ok(ListedFile {
            key: key.to_string(),
            file,
        }),
        _ => Err(damaged(backup_name, "lists a file under an unsafe key")),
    }
}

fn backup_partition(
    value: &Value,
    backup_name: &str,
    partition_count: f64,
) -> Result<BackupPartition> {
    let malformed = || damaged(backup_name, "holds a malformed partition entry");
    let map = value.as_object().ok_or_else(malformed)?;
    let partition_id = count(map.get("partitionId"))
        .filter(|id| *id < partition_count)
        .ok_or_else(malformed)?;
    let last_seq_no = count(map.get("lastSeqNo")).ok_or_else(malformed)?;
    let Some(Value::Array(entries)) = map.get("files") else {
        return Err(malformed());
    };
    if entries.len() > MAX_BACKUP_FILES_PER_PARTITION {
        return Err(malformed());
    }
    let files = entries
        .iter()
        .map(|entry| listed_file(entry, backup_name))
        .collect::<Result<Vec<_>>>()?;
    let mut keys: Vec<&str> = files.iter().map(|file| file.key.as_str()).collect();
    keys.sort_unstable();
    if keys.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(damaged(
            backup_name,
            &format!("lists one key twice in partition {partition_id}"),
        ));
    }
    Ok(BackupPartition {
        partition_id: partition_id as u64,
        last_seq_no,
        manifest: stored_file(map.get("manifest"), backup_name)?,
        files,
    })
}

fn constraints_of(value: Option<&Value>) -> Option<AllocationConstraints> {
    let map = value?.as_object()?;
    let zone_awareness = map.get("zoneAwareness")?.as_bool()?;
    let zone_attribute = map
        .get("zoneAttribute")?
        .as_str()
        .filter(|attribute| !attribute.is_empty())?;
    let max_shards_per_node = match map.get("maxShardsPerNode") {
        Some(Value::Null) => None,
        other => Some(integer(other).filter(|shards| *shards > 0.0)?),
    };
    Some(AllocationConstraints {
        zone_awareness,
        zone_attribute: zone_attribute.to_string(),
        max_shards_per_node,
    })
}

pub(crate) fn backup_manifest_from_wire(raw: &Value, backup_name: &str) -> Result<BackupManifest> {
    let header = || damaged(backup_name, "holds a malformed header");
    let map = raw.as_object().ok_or_else(header)?;
    if map.get("name").and_then(Value::as_str) != Some(backup_name) {
        return Err(header());
    }
    let cluster_uuid = map
        .get("clusterUuid")
        .and_then(Value::as_str)
        .ok_or_else(header)?;
    let index_name = map
        .get("indexName")
        .and_then(Value::as_str)
        .ok_or_else(header)?;
    let started_at = count(map.get("startedAt")).ok_or_else(header)?;
    let completed_at = count(map.get("completedAt")).ok_or_else(header)?;
    let partition_count = integer(map.get("partitionCount"))
        .filter(|n| *n >= 1.0 && *n <= MAX_PARTITION_COUNT)
        .ok_or_else(header)?;
    let replication_factor = count(map.get("replicationFactor"))
        .filter(|n| *n <= MAX_REPLICATION_FACTOR)
        .ok_or_else(header)?;
    let Some(Value::Array(entries)) = map.get("partitions") else {
        return Err(header());
    };
    if entries.len() as f64 != partition_count {
        return Err(header());
    }
    let sync_epoch = match map.get("syncEpoch") {
        None => None,
        Some(Value::String(epoch)) if is_sync_epoch(epoch) => Some(epoch.clone()),
        Some(_) => return Err(header()),
    };
    let taken_by = match map.get("takenBy") {
        None => None,
        Some(Value::String(taker)) => Some(taker.clone()),
        Some(_) => return Err(header()),
    };
    let constraints = constraints_of(map.get("constraints"))
        .ok_or_else(|| damaged(backup_name, "holds malformed allocation constraints"))?;
    let partitions = entries
        .iter()
        .map(|entry| backup_partition(entry, backup_name, partition_count))
        .collect::<Result<Vec<_>>>()?;
    if partitions
        .iter()
        .enumerate()
        .any(|(position, entry)| entry.partition_id != position as u64)
    {
        return Err(damaged(
            backup_name,
            "lists its partitions out of partitionId order",
        ));
    }
    let config = stored_file(map.get("config"), backup_name)?;
    let query_history = match map.get("queryHistory") {
        None => None,
        Some(Value::Array(files)) if files.len() <= MAX_BACKUP_HISTORY_FILES => {
            let files = files
                .iter()
                .map(|file| stored_file(Some(file), backup_name))
                .collect::<Result<Vec<_>>>()?;
            if files.iter().any(|file| file.bytes > MAX_HISTORY_FILE_BYTES) {
                return Err(damaged(
                    backup_name,
                    &format!(
                        "lists a query history file longer than {MAX_HISTORY_FILE_BYTES} bytes"
                    ),
                ));
            }
            Some(files)
        }
        Some(_) => return Err(damaged(backup_name, "holds a malformed query history list")),
    };
    Ok(BackupManifest {
        name: backup_name.to_string(),
        cluster_uuid: cluster_uuid.to_string(),
        index_name: index_name.to_string(),
        started_at,
        completed_at,
        partition_count: partition_count as u64,
        sync_epoch,
        taken_by,
        replication_factor,
        constraints,
        config,
        query_history,
        partitions,
    })
}

pub(crate) fn decode_backup_manifest(bytes: &[u8], backup_name: &str) -> Result<BackupManifest> {
    let what = format!("manifest of backup '{backup_name}'");
    let expected = Expectation {
        version: BACKUP_MANIFEST_ENVELOPE_VERSION,
        what: &what,
        allows_compression: false,
    };
    let raw = open_checksummed(bytes, &expected)
        .and_then(|(_, payload)| decode_value(payload.bytes()))
        .map_err(|error| {
            damaged(
                backup_name,
                &format!("is not readable: {}", error.message()),
            )
        })?;
    backup_manifest_from_wire(&raw, backup_name)
}

fn stored_file_wire(file: &StoredFile) -> Value {
    let mut map = Map::new();
    map.insert("sha256", Value::String(file.sha256.clone()));
    map.insert("bytes", Value::Number(file.bytes as f64));
    Value::Object(map)
}

pub(crate) fn backup_manifest_to_wire(manifest: &BackupManifest) -> Value {
    let mut map = Map::new();
    map.insert("name", Value::String(manifest.name.clone()));
    map.insert("clusterUuid", Value::String(manifest.cluster_uuid.clone()));
    map.insert("indexName", Value::String(manifest.index_name.clone()));
    map.insert("startedAt", Value::Number(manifest.started_at));
    map.insert("completedAt", Value::Number(manifest.completed_at));
    map.insert(
        "partitionCount",
        Value::Number(manifest.partition_count as f64),
    );
    if let Some(epoch) = &manifest.sync_epoch {
        map.insert("syncEpoch", Value::String(epoch.clone()));
    }
    if let Some(taker) = &manifest.taken_by {
        map.insert("takenBy", Value::String(taker.clone()));
    }
    map.insert(
        "replicationFactor",
        Value::Number(manifest.replication_factor),
    );
    let mut constraints = Map::new();
    constraints.insert(
        "zoneAwareness",
        Value::Bool(manifest.constraints.zone_awareness),
    );
    constraints.insert(
        "zoneAttribute",
        Value::String(manifest.constraints.zone_attribute.clone()),
    );
    constraints.insert(
        "maxShardsPerNode",
        manifest
            .constraints
            .max_shards_per_node
            .map_or(Value::Null, Value::Number),
    );
    map.insert("constraints", Value::Object(constraints));
    map.insert("config", stored_file_wire(&manifest.config));
    if let Some(history) = &manifest.query_history {
        map.insert(
            "queryHistory",
            Value::Array(history.iter().map(stored_file_wire).collect()),
        );
    }
    let partitions = manifest
        .partitions
        .iter()
        .map(|partition| {
            let mut entry = Map::new();
            entry.insert("partitionId", Value::Number(partition.partition_id as f64));
            entry.insert("lastSeqNo", Value::Number(partition.last_seq_no));
            entry.insert("manifest", stored_file_wire(&partition.manifest));
            let files = partition
                .files
                .iter()
                .map(|listed| {
                    let mut file = Map::new();
                    file.insert("key", Value::String(listed.key.clone()));
                    file.insert("sha256", Value::String(listed.file.sha256.clone()));
                    file.insert("bytes", Value::Number(listed.file.bytes as f64));
                    Value::Object(file)
                })
                .collect();
            entry.insert("files", Value::Array(files));
            Value::Object(entry)
        })
        .collect();
    map.insert("partitions", Value::Array(partitions));
    Value::Object(map)
}

pub(crate) fn encode_backup_manifest(manifest: &BackupManifest) -> Result<Vec<u8>> {
    let payload = encode_value(&backup_manifest_to_wire(manifest))?;
    pack(
        &payload,
        BACKUP_MANIFEST_ENVELOPE_VERSION,
        Compression::None,
        "backup manifest",
    )
}
