use std::sync::Arc;

use super::retention::publish;
use super::{log_store_of, sync_epoch_of, sync_is_on};
use crate::durability::store::DurabilityStore;
use crate::durability::sync_files::PublishedSnapshot;
use crate::durability::sync_store::PinnedPublished;
use crate::engine::Narsil;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::{ARCHIVE_CONFIG_ENTRY, ARCHIVE_MANIFEST_ENTRY};
use crate::format::archive_tar::{tar_end, tar_entry_headers, tar_padding};
use crate::format::index_configuration::decode_index_configuration;
use crate::value::Value;

enum PartSource {
    Bytes(Vec<u8>),
    File(String),
}

struct ArchivePart {
    start: u64,
    length: u64,
    source: PartSource,
}

/// The published snapshot of a synced index as one snapshot archive, which [`Narsil::sync_snapshot`] returns for a
/// device to download.
///
/// Every file that the archive lists stays on disk while this value lives, even after later checkpoints and
/// publications stop listing it, so that a download that reads the archive in pieces reads the same bytes
/// throughout.
pub struct SyncSnapshot {
    store: Arc<DurabilityStore>,
    pinned: PinnedPublished,
    epoch: String,
    parts: Vec<ArchivePart>,
    length: u64,
    index_name: String,
}

fn not_enabled(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::SYNC_NOT_ENABLED,
        format!("Index \"{index_name}\" has device sync off"),
    )
    .with_details([("indexName", Value::from(index_name))])
}

fn replaced(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!(
            "Index \"{index_name}\" was dropped or restored while a device downloaded its published snapshot"
        ),
    )
}

fn push_bytes(parts: &mut Vec<ArchivePart>, at: &mut u64, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    let length = bytes.len() as u64;
    if let Some(ArchivePart {
        length: last_length,
        source: PartSource::Bytes(last),
        ..
    }) = parts.last_mut()
    {
        last.extend_from_slice(&bytes);
        *last_length += length;
    } else {
        parts.push(ArchivePart {
            start: *at,
            length,
            source: PartSource::Bytes(bytes),
        });
    }
    *at += length;
}

fn entry_bytes(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut out = tar_entry_headers(name, bytes.len() as u64);
    out.extend_from_slice(bytes);
    out.extend_from_slice(&tar_padding(bytes.len() as u64));
    out
}

fn archive_parts(
    published: &PublishedSnapshot,
    index_name: &str,
) -> Result<(Vec<ArchivePart>, u64)> {
    let mut parts = Vec::new();
    let mut at = 0u64;
    push_bytes(
        &mut parts,
        &mut at,
        entry_bytes(ARCHIVE_CONFIG_ENTRY, &published.config),
    );
    push_bytes(
        &mut parts,
        &mut at,
        entry_bytes(ARCHIVE_MANIFEST_ENTRY, &published.manifest_bytes),
    );
    let prefix = format!("{index_name}/");
    for file in published.manifest.file_refs() {
        let Some(name) = file.key.strip_prefix(&prefix) else {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "The published manifest lists \"{}\" outside the index",
                    file.key
                ),
            ));
        };
        push_bytes(&mut parts, &mut at, tar_entry_headers(name, file.bytes));
        if file.bytes > 0 {
            parts.push(ArchivePart {
                start: at,
                length: file.bytes,
                source: PartSource::File(file.key.clone()),
            });
            at += file.bytes;
        }
        push_bytes(&mut parts, &mut at, tar_padding(file.bytes));
    }
    push_bytes(&mut parts, &mut at, tar_end());
    Ok((parts, at))
}

fn published_epoch(published: &PublishedSnapshot) -> Option<String> {
    let (_, payload) = decode_index_configuration(&published.config).ok()?;
    match payload.get("syncEpoch") {
        Some(Value::String(epoch)) => Some(epoch.clone()),
        _ => None,
    }
}

impl SyncSnapshot {
    fn new(
        store: Arc<DurabilityStore>,
        pinned: PinnedPublished,
        epoch: String,
        index_name: &str,
    ) -> Result<Self> {
        let (parts, length) = archive_parts(&pinned.published, index_name)?;
        Ok(SyncSnapshot {
            store,
            pinned,
            epoch,
            parts,
            length,
            index_name: index_name.to_string(),
        })
    }

    /// Returns the entity tag of the archive: the SHA-256 of the published snapshot's payload, as 64 lowercase
    /// hexadecimal digits, which stays the same while the engine serves the same snapshot.
    pub fn entity_tag(&self) -> &str {
        &self.pinned.published.entity_tag
    }

    /// Returns the epoch that the archive belongs to, as 32 lowercase hexadecimal digits.
    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// Returns the length of the archive in bytes.
    pub fn byte_length(&self) -> u64 {
        self.length
    }

    /// Copies the bytes of the archive from `offset` into `buffer` and returns how many it copied, which is fewer
    /// than the buffer holds only at the end of the archive, and 0 at or past the end.
    ///
    /// Fails with `PERSISTENCE_LOAD_FAILED` once a restore or a drop has replaced the index's files, and with the
    /// error of the file read where a read fails.
    pub fn read_at(&self, offset: u64, buffer: &mut [u8]) -> Result<usize> {
        let mut copied = 0usize;
        let mut at = offset;
        let first = self
            .parts
            .partition_point(|part| part.start + part.length <= at);
        for part in &self.parts[first..] {
            if copied == buffer.len() {
                break;
            }
            let within = at - part.start;
            let take = (part.length - within).min((buffer.len() - copied) as u64) as usize;
            let target = &mut buffer[copied..copied + take];
            match &part.source {
                PartSource::Bytes(bytes) => {
                    target.copy_from_slice(&bytes[within as usize..within as usize + take]);
                }
                PartSource::File(key) => {
                    let read = self.store.read_file_range(key, within, take as u64)?;
                    if !self.pinned.unreplaced() {
                        return Err(replaced(&self.index_name));
                    }
                    if read.len() != take {
                        return Err(NarsilError::new(
                            ErrorCode::PERSISTENCE_LOAD_FAILED,
                            format!(
                                "The published file \"{key}\" is shorter than its manifest lists"
                            ),
                        ));
                    }
                    target.copy_from_slice(&read);
                }
            }
            copied += take;
            at += take as u64;
        }
        Ok(copied)
    }
}

fn activate(index: &IndexState) -> Result<String> {
    let _writer = index.lock_writes()?;
    let Some(log) = index.log() else {
        return Err(not_enabled(&index.name));
    };
    let mut metadata = log.metadata(index);
    if !sync_is_on(&metadata) {
        return Err(not_enabled(&index.name));
    }
    let Some(epoch) = sync_epoch_of(&metadata).map(str::to_string) else {
        return Err(not_enabled(&index.name));
    };
    if metadata.sync_active != Some(true) {
        metadata.sync_active = Some(true);
        log.write_recorded(metadata)?;
    }
    Ok(epoch)
}

impl Narsil {
    /// Returns the published snapshot of a synced index for a device to download, publishing one first where the
    /// index has none for its epoch.
    ///
    /// The first call records in the index's metadata that a device has asked for the snapshot, so that every later
    /// checkpoint keeps the log segments that it covers as history. To publish, the engine takes a checkpoint that
    /// holds every write acknowledged before the call and writes the snapshot's configuration and manifest in one
    /// file. Later calls return the same snapshot until the history limits make the engine publish the next one.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, with `SYNC_NOT_ENABLED` where
    /// device sync is off for it, with `SYNC_DURABILITY_REQUIRED` where the engine has no write-ahead log
    /// durability, and with the error of the checkpoint where it fails.
    pub fn sync_snapshot(&self, index: &str) -> Result<SyncSnapshot> {
        let (_name, state) = self.inner.open_index_in_turn(index)?;
        if state.log().is_none() {
            return Err(not_enabled(index));
        }
        let store = log_store_of(&state)?;
        let epoch = activate(&state)?;
        if let Some(pinned) = store.pin_published(index)?
            && published_epoch(&pinned.published).as_deref() == Some(epoch.as_str())
        {
            return SyncSnapshot::new(store, pinned, epoch, index);
        }
        publish(&state, &store)?;
        let pinned = store
            .pin_published(index)?
            .filter(|pinned| published_epoch(&pinned.published).as_deref() == Some(epoch.as_str()))
            .ok_or_else(|| {
                NarsilError::new(
                    ErrorCode::SYNC_NOT_ENABLED,
                    format!(
                        "The device sync state of index \"{index}\" changed while the engine published its snapshot"
                    ),
                )
            })?;
        SyncSnapshot::new(store, pinned, epoch, index)
    }
}
