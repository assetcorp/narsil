use narsil::replication::{BackupConstraints, BackupManifest, StoredFile};
use narsil::{Map, Value};

use crate::constants::MAX_SAFE_INTEGER;

pub(crate) const SYNC_BACKUP_TAKER: &str = "sync";
pub(crate) const CHANGES_BACKUP_TAKER: &str = "changes";
const DEFAULT_ZONE_ATTRIBUTE: &str = "zone";

pub(crate) fn is_backup_taker(value: &str) -> bool {
    value == SYNC_BACKUP_TAKER || value == CHANGES_BACKUP_TAKER
}

pub(crate) fn stored_files_of(manifest: &BackupManifest) -> Vec<&StoredFile> {
    let mut files: Vec<&StoredFile> = vec![&manifest.config];
    files.extend(manifest.query_history.iter().flatten());
    for partition in &manifest.partitions {
        files.push(&partition.manifest);
        files.extend(partition.files.iter().map(|listed| &listed.file));
    }
    files
}

pub(crate) fn whole_count(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number))
            if number.fract() == 0.0 && *number >= 0.0 && *number <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*number)
        }
        _ => None,
    }
}

fn absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

pub(crate) fn read_allocation_constraints(value: &Value) -> Option<BackupConstraints> {
    let map: &Map = value.as_object()?;
    let zone_awareness = match map.get("zoneAwareness") {
        found if absent(found) => false,
        Some(Value::Bool(aware)) => *aware,
        _ => return None,
    };
    let zone_attribute = match map.get("zoneAttribute") {
        found if absent(found) => DEFAULT_ZONE_ATTRIBUTE.to_string(),
        Some(Value::String(attribute)) if !attribute.is_empty() => attribute.clone(),
        _ => return None,
    };
    let max_shards_per_node = match map.get("maxShardsPerNode") {
        found if absent(found) => None,
        found => Some(whole_count(found).filter(|shards| *shards > 0.0)?),
    };
    Some(BackupConstraints {
        zone_awareness,
        zone_attribute,
        max_shards_per_node,
    })
}

pub(crate) fn constraints_wire(constraints: &BackupConstraints) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("zoneAwareness", Value::Bool(constraints.zone_awareness));
    map.insert(
        "zoneAttribute",
        Value::String(constraints.zone_attribute.clone()),
    );
    map.insert(
        "maxShardsPerNode",
        constraints
            .max_shards_per_node
            .map_or(Value::Null, Value::Number),
    );
    Value::Object(map)
}
