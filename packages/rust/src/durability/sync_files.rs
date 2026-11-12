use std::collections::BTreeSet;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, Expectation, MAX_FILE_BYTES, open_checksummed};
use crate::format::manifest::{
    DecodedManifest, SegmentManifest, decode_manifest_payload, open_manifest_payload,
};
use crate::format::metadata::{IndexMetadata, pack_lenient_envelope};
use crate::value::{Map, Value, decode_value, write_binary, write_map_header, write_string};

use super::checkpoint_files::published_snapshot_key;
use super::checkpoint_store::CheckpointStore;

const PUBLISHED_SNAPSHOT_ENVELOPE_VERSION: u8 = 1;
const PUBLISHED_SNAPSHOT_WHAT: &str = "published snapshot";
const SYNC_KEY_NUMBER_WIDTH: usize = 16;
const MAX_SAFE_KEY_NUMBER: u64 = 9_007_199_254_740_991;

/// The snapshot that a synced index publishes for its devices: the configuration and the manifest of one
/// checkpoint, and the keys of every file that the manifest lists.
pub(crate) struct PublishedSnapshot {
    pub(crate) config: Vec<u8>,
    pub(crate) manifest_bytes: Vec<u8>,
    pub(crate) manifest: SegmentManifest,
    pub(crate) keys: BTreeSet<String>,
}

impl PublishedSnapshot {
    /// Returns the last sequence number that the snapshot holds for `partition_id`, or 0 where it lists none.
    pub(crate) fn last_seq_no(&self, partition_id: u32) -> u64 {
        self.manifest
            .checkpoint
            .iter()
            .find(|entry| entry.partition_id == partition_id)
            .map_or(0, |entry| entry.last_seq_no)
    }
}

/// One log segment that a checkpoint moved into the history of a synced index.
pub(crate) struct HistorySegment {
    pub(crate) key: String,
    pub(crate) partition_id: u32,
    pub(crate) start_seq_no: u64,
    pub(crate) moved_at_ms: u64,
}

fn sync_prefix(index_name: &str) -> String {
    format!("{index_name}/sync/")
}

fn history_root(index_name: &str) -> String {
    format!("{index_name}/history/")
}

fn history_prefix(index_name: &str, partition_id: u32) -> String {
    format!("{}{partition_id}/", history_root(index_name))
}

/// Returns the key that a log segment takes once a checkpoint moves it into history.
pub(crate) fn history_key(
    index_name: &str,
    partition_id: u32,
    start_seq_no: u64,
    moved_at_ms: u64,
) -> String {
    format!(
        "{}{start_seq_no:0width$}-{moved_at_ms:0width$}",
        history_prefix(index_name, partition_id),
        width = SYNC_KEY_NUMBER_WIDTH
    )
}

fn key_number(text: &str) -> Option<u64> {
    if text.len() != SYNC_KEY_NUMBER_WIDTH || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>()
        .ok()
        .filter(|&value| value <= MAX_SAFE_KEY_NUMBER)
}

fn parse_history_key(index_name: &str, key: &str) -> Option<HistorySegment> {
    let tail = key.strip_prefix(&history_root(index_name))?;
    let (partition, name) = tail.split_once('/')?;
    let (start, moved) = name.split_once('-')?;
    if partition.is_empty() || !partition.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(HistorySegment {
        key: key.to_string(),
        partition_id: partition.parse::<u32>().ok()?,
        start_seq_no: key_number(start)?,
        moved_at_ms: key_number(moved)?,
    })
}

/// Returns the history segments of an index, or of one of its partitions, in partition and sequence order.
pub(crate) fn list_history(
    store: &dyn CheckpointStore,
    index_name: &str,
    partition_id: Option<u32>,
) -> Result<Vec<HistorySegment>> {
    let prefix = match partition_id {
        Some(partition_id) => history_prefix(index_name, partition_id),
        None => history_root(index_name),
    };
    let mut segments: Vec<HistorySegment> = store
        .list(&prefix)?
        .into_iter()
        .filter_map(|key| parse_history_key(index_name, &key))
        .collect();
    segments.sort_by_key(|segment| (segment.partition_id, segment.start_seq_no));
    Ok(segments)
}

pub(crate) fn remove_history(
    store: &dyn CheckpointStore,
    index_name: &str,
    partition_id: Option<u32>,
) -> Result<()> {
    for segment in list_history(store, index_name, partition_id)? {
        store.remove(&segment.key)?;
    }
    Ok(())
}

fn unreadable_published(index_name: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The published snapshot of index \"{index_name}\" {reason}"),
    )
}

fn bytes_field(map: &Map, key: &str) -> Option<Vec<u8>> {
    match map.get(key) {
        Some(Value::Bytes(bytes)) => Some(bytes.clone()),
        _ => None,
    }
}

/// Reads the published snapshot of an index, or returns `None` where the index has none.
pub(crate) fn read_published(
    store: &dyn CheckpointStore,
    index_name: &str,
) -> Result<Option<PublishedSnapshot>> {
    let Some(bytes) = store.read_within(&published_snapshot_key(index_name), MAX_FILE_BYTES)?
    else {
        return Ok(None);
    };
    let expectation = Expectation {
        version: PUBLISHED_SNAPSHOT_ENVELOPE_VERSION,
        what: PUBLISHED_SNAPSHOT_WHAT,
        allows_compression: false,
    };
    let (_, payload) = open_checksummed(&bytes, &expectation)?;
    let Value::Object(map) = decode_value(payload.bytes())? else {
        return Err(unreadable_published(
            index_name,
            "lacks its configuration or its manifest",
        ));
    };
    let (Some(config), Some(manifest_bytes)) =
        (bytes_field(&map, "config"), bytes_field(&map, "manifest"))
    else {
        return Err(unreadable_published(
            index_name,
            "lacks its configuration or its manifest",
        ));
    };
    let (_, raw) = open_manifest_payload(&manifest_bytes)?;
    let DecodedManifest::Current(manifest) = decode_manifest_payload(&raw, index_name)? else {
        return Err(unreadable_published(
            index_name,
            "holds a manifest of an earlier layout",
        ));
    };
    let keys = manifest
        .file_refs()
        .into_iter()
        .map(|file| file.key.clone())
        .collect();
    Ok(Some(PublishedSnapshot {
        config,
        manifest_bytes,
        manifest,
        keys,
    }))
}

/// Writes the published snapshot of an index with an atomic write, as one file that pairs `config` with the
/// manifest, so that a crash can never pair the configuration of one snapshot with another's manifest.
pub(crate) fn write_published(
    store: &dyn CheckpointStore,
    index_name: &str,
    config: &[u8],
    manifest_bytes: &[u8],
) -> Result<PublishedSnapshot> {
    let mut payload = Vec::with_capacity(config.len() + manifest_bytes.len() + 32);
    write_map_header(&mut payload, 2);
    write_string(&mut payload, "config");
    write_binary(&mut payload, config);
    write_string(&mut payload, "manifest");
    write_binary(&mut payload, manifest_bytes);
    let packed = pack_lenient_envelope(
        &payload,
        PUBLISHED_SNAPSHOT_ENVELOPE_VERSION,
        Compression::None,
        true,
    )?;
    store.write_commit(&published_snapshot_key(index_name), &packed)?;
    read_published(store, index_name)?
        .ok_or_else(|| unreadable_published(index_name, "is missing after the engine wrote it"))
}

/// Settles the sync files of an index as recovery opens it: deletes every file under its sync folder other than
/// the published snapshot, the published snapshot where device sync is not active, and the history where neither
/// device sync nor change capture keeps one. A published snapshot that fails to read goes as well, so that the
/// next request publishes a fresh one.
pub(crate) fn settle_sync_files(
    store: &dyn CheckpointStore,
    index_name: &str,
    metadata: &IndexMetadata,
) -> Result<()> {
    let published_key = published_snapshot_key(index_name);
    for key in store.list(&sync_prefix(index_name))? {
        if key != published_key {
            store.remove(&key)?;
        }
    }
    if !metadata.keeps_history() {
        remove_history(store, index_name, None)?;
    }
    if !metadata.sync_is_active() || read_published(store, index_name).is_err() {
        store.remove(&published_key)?;
    }
    Ok(())
}

/// Deletes the published snapshot of an index, then every file that only the published manifest listed, then the
/// history where `with_history` is set. A file that `keeps` reports, such as one that a reader holds, stays for
/// the next checkpoint to delete.
pub(crate) fn release_published(
    store: &dyn CheckpointStore,
    index_name: &str,
    current: &BTreeSet<String>,
    keeps: &dyn Fn(&str) -> bool,
    with_history: bool,
) -> Result<()> {
    let previous = read_published(store, index_name).ok().flatten();
    store.remove(&published_snapshot_key(index_name))?;
    if let Some(previous) = previous {
        remove_only_published(store, &previous.keys, current, &BTreeSet::new(), keeps)?;
    }
    if with_history {
        remove_history(store, index_name, None)?;
    }
    Ok(())
}

/// Deletes each file of `previous` that neither the index's manifest nor the next published manifest lists.
pub(crate) fn remove_only_published(
    store: &dyn CheckpointStore,
    previous: &BTreeSet<String>,
    current: &BTreeSet<String>,
    next: &BTreeSet<String>,
    keeps: &dyn Fn(&str) -> bool,
) -> Result<()> {
    for key in previous {
        if current.contains(key) || next.contains(key) || keeps(key) {
            continue;
        }
        store.remove(key)?;
    }
    Ok(())
}
