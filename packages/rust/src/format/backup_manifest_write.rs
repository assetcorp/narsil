use super::backup_manifest::{BACKUP_MANIFEST_ENVELOPE_VERSION, BackupManifest, StoredFile};
use crate::error::Result;
use crate::format::envelope::{Compression, pack};
use crate::value::{Map, Value, encode_value};

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

/// Returns the bytes of `manifest` as the store holds them: a checksummed, uncompressed `.nrsl` file.
///
/// # Errors
///
/// Fails with the encoder's error where a value of the manifest cannot be encoded.
pub fn encode_backup_manifest(manifest: &BackupManifest) -> Result<Vec<u8>> {
    let payload = encode_value(&backup_manifest_to_wire(manifest))?;
    pack(
        &payload,
        BACKUP_MANIFEST_ENVELOPE_VERSION,
        Compression::None,
        "backup manifest",
    )
}
