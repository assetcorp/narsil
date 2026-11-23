use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Expectation, MAX_FILE_BYTES, open_checksummed};
use crate::format::fields::whole_number;
use crate::format::metadata_parts::is_sync_epoch;
use crate::value::{Value, decode_value};

pub(crate) use super::backup_manifest_write::backup_manifest_to_wire;
pub use super::backup_manifest_write::encode_backup_manifest;

pub(crate) const BACKUP_MANIFEST_ENVELOPE_VERSION: u8 = 1;
const MAX_PARTITION_COUNT: f64 = 65_536.0;
const MAX_REPLICATION_FACTOR: f64 = 255.0;
const MAX_BACKUP_FILES_PER_PARTITION: usize = 1_000_000;
const MAX_BACKUP_HISTORY_FILES: usize = 1_000_000;
const MAX_BACKUP_FILE_PATH_LENGTH: usize = 1_024;
const MAX_HISTORY_FILE_BYTES: u64 = 16_777_216;
const SHA256_HEX_DIGITS: usize = 64;

/// A file of a cluster backup, stored under the SHA-256 of its bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredFile {
    /// The SHA-256 of the file's bytes, as 64 lowercase hexadecimal digits.
    pub sha256: String,
    /// The file's length in bytes.
    pub bytes: u64,
}

/// A file that a partition of a cluster backup lists, under its key without the leading `<indexName>/`.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedFile {
    /// The file's key without the leading `<indexName>/`.
    pub key: String,
    /// Where the store holds the file's bytes.
    pub file: StoredFile,
}

/// One partition of a cluster backup.
#[derive(Debug, Clone, PartialEq)]
pub struct BackupPartition {
    /// The partition's id.
    pub partition_id: u64,
    /// The sequence number of the newest write that the partition's files hold.
    pub last_seq_no: f64,
    /// The partition's segment manifest.
    pub manifest: StoredFile,
    /// Every file that the partition's manifest lists, in its order.
    pub files: Vec<ListedFile>,
}

/// The rules that placed the partitions of a backed up index.
#[derive(Debug, Clone, PartialEq)]
pub struct BackupConstraints {
    /// Whether the cluster spreads each partition's copies across zones.
    pub zone_awareness: bool,
    /// The node attribute that holds a node's zone.
    pub zone_attribute: String,
    /// The most copies that one node holds, or `None` for no limit.
    pub max_shards_per_node: Option<f64>,
}

/// The manifest of a cluster backup, which the store holds under `<keyPrefix>/backups/<backupName>`.
#[derive(Debug, Clone, PartialEq)]
pub struct BackupManifest {
    /// The backup's name.
    pub name: String,
    /// The UUID of the cluster that took the backup.
    pub cluster_uuid: String,
    /// The index that the backup holds.
    pub index_name: String,
    /// When the backup started, in milliseconds since the Unix epoch.
    pub started_at: f64,
    /// When the controller wrote the manifest, in milliseconds since the Unix epoch.
    pub completed_at: f64,
    /// The index's partition count.
    pub partition_count: u64,
    /// The index's sync epoch where device sync was on.
    pub sync_epoch: Option<String>,
    /// `sync` or `changes` for a backup that device sync or change capture took.
    pub taken_by: Option<String>,
    /// The index's replication factor.
    pub replication_factor: f64,
    /// The rules that placed the index's partitions.
    pub constraints: BackupConstraints,
    /// The index configuration payload.
    pub config: StoredFile,
    /// The query history files, where the backup holds them.
    pub query_history: Option<Vec<StoredFile>>,
    /// One entry for each partition, in partition id order.
    pub partitions: Vec<BackupPartition>,
}

fn damaged(backup_name: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::BACKUP_DAMAGED,
        format!("The manifest of backup '{backup_name}' {reason}"),
    )
}

fn count(value: Option<&Value>) -> Option<f64> {
    whole_number(value).filter(|number| *number >= 0.0)
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

fn is_safe_file_key(key: &str) -> bool {
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

fn constraints_of(value: Option<&Value>) -> Option<BackupConstraints> {
    let map = value?.as_object()?;
    let zone_awareness = map.get("zoneAwareness")?.as_bool()?;
    let zone_attribute = map
        .get("zoneAttribute")?
        .as_str()
        .filter(|attribute| !attribute.is_empty())?;
    let max_shards_per_node = match map.get("maxShardsPerNode") {
        Some(Value::Null) => None,
        other => Some(whole_number(other).filter(|shards| *shards > 0.0)?),
    };
    Some(BackupConstraints {
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
    let partition_count = whole_number(map.get("partitionCount"))
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

/// Returns the manifest of the backup `backup_name` that `bytes` hold.
///
/// # Errors
///
/// Fails with `BACKUP_DAMAGED` where the bytes fail to decode or break a rule of a backup manifest, such as a
/// name other than `backup_name`.
pub fn decode_backup_manifest(bytes: &[u8], backup_name: &str) -> Result<BackupManifest> {
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
