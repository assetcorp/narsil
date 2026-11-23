use std::io::{self, BufWriter, Write};

use super::{CopyPosition, PartitionCopies};
use crate::engine::durable::archive::ArchiveCheckpoint;
use crate::engine::durable::partition_archive::partition_archive;
use crate::engine::memory::require_restore_memory;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::{ArchiveSource, write_snapshot_archive};
use crate::format::envelope::Compression;
use crate::format::index_configuration::{decode_index_configuration, encode_index_configuration};
use crate::format::manifest::{
    DecodedManifest, PartitionCheckpoint, SegmentManifest, TermStart, decode_manifest_payload,
    encode_manifest, listed_keys, open_manifest_payload, source_index_name,
};
use crate::format::manifest_refs::FileRef;
use crate::value::{Map, Value};

const RESTORED_FIRST_SEQ_NO: u64 = 1;

/// One file that a partition backup lists, under its key without the leading `<indexName>/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupListedFile {
    /// The file's key without the leading `<indexName>/`.
    pub key: String,
    /// The file's length in bytes.
    pub bytes: u64,
}

/// The files of one partition of a cluster copy, as a primary saves them for a backup: the index configuration,
/// the partition's segment manifest without its term history, and every file that the manifest lists.
///
/// The files describe the copy at `last_seq_no`, and they stay readable until this value drops.
pub struct PartitionBackup {
    /// The index configuration payload.
    pub config: Vec<u8>,
    /// The partition's segment manifest, without its term history.
    pub manifest_bytes: Vec<u8>,
    /// Every file that the manifest lists, in its order.
    pub files: Vec<BackupListedFile>,
    /// The sequence number of the newest write that the files hold.
    pub last_seq_no: u64,
    checkpoint: ArchiveCheckpoint,
    refs: Vec<FileRef>,
}

impl PartitionBackup {
    /// Returns `length` bytes of the listed file at `position` in [`PartitionBackup::files`], from `offset`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where no file holds that position, and with `PERSISTENCE_LOAD_FAILED` where
    /// the range passes the file's end.
    pub fn read_range(&self, position: usize, offset: u64, length: u64) -> Result<Vec<u8>> {
        let Some(file) = self.refs.get(position) else {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "The partition backup lists {} files, so it holds none at position {position}",
                    self.refs.len()
                ),
            ));
        };
        self.checkpoint.read_range(file, offset, length)
    }
}

/// The stored files of one partition of a backup, which a primary loads in place of its copy of that partition.
pub struct BackupPartitionFiles<'a> {
    /// The backup's name, which every refusal gives.
    pub backup_name: &'a str,
    /// The backup's index configuration payload.
    pub config: &'a [u8],
    /// The partition's segment manifest.
    pub manifest: &'a [u8],
    /// Every file that the backup lists for the partition, in the manifest's order.
    pub files: &'a [BackupListedFile],
    /// The sequence number that the backup lists for the partition.
    pub last_seq_no: u64,
}

/// Returns the fields of the index configuration payload that `bytes` hold, as a backup stores it.
///
/// # Errors
///
/// Fails with `PERSISTENCE_CRC_MISMATCH` or another envelope error where the payload is damaged, and with
/// `CONFIG_INVALID` where it holds no schema or no language.
pub fn decode_backup_index_configuration(bytes: &[u8]) -> Result<Map> {
    decode_index_configuration(bytes).map(|(_, configuration)| configuration)
}

/// Returns `configuration` as an uncompressed index configuration payload.
///
/// # Errors
///
/// Fails with the encoder's error where a value of the configuration cannot be encoded.
pub fn encode_backup_index_configuration(configuration: &Map) -> Result<Vec<u8>> {
    encode_index_configuration(configuration, Compression::None)
}

fn durability_required(index: &str, partition: u32) -> NarsilError {
    NarsilError::new(
        ErrorCode::BACKUP_DURABILITY_REQUIRED,
        format!(
            "The primary of partition {partition} of index '{index}' runs without write-ahead log durability, so it can't take a backup"
        ),
    )
    .with_details([
        ("indexName", Value::from(index)),
        ("partitionId", Value::from(partition)),
    ])
}

fn damaged(backup_name: &str, partition: u32, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::BACKUP_DAMAGED,
        format!(
            "The manifest of partition {partition} in backup '{backup_name}' {reason}, so the restore loads nothing"
        ),
    )
    .with_details([
        ("backupName", Value::from(backup_name)),
        ("partitionId", Value::from(partition)),
    ])
}

fn save_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_SAVE_FAILED, message)
}

fn manifest_without_term_history(manifest: &SegmentManifest) -> SegmentManifest {
    let mut stripped = manifest.clone();
    for entry in &mut stripped.checkpoint {
        entry.term_history = None;
    }
    stripped
}

fn listed_key(file: &FileRef, source_index_name: &str) -> Result<String> {
    file.key
        .strip_prefix(source_index_name)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(str::to_string)
        .ok_or_else(|| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("The checkpoint lists \"{}\" outside its index", file.key),
            )
            .with_details([
                ("key", Value::from(file.key.as_str())),
                ("indexName", Value::from(source_index_name)),
            ])
        })
}

struct PartitionManifest {
    manifest: SegmentManifest,
    source_index_name: String,
}

fn read_partition_manifest(
    backup: &BackupPartitionFiles<'_>,
    partition: u32,
) -> Result<PartitionManifest> {
    let unreadable = |error: NarsilError| {
        damaged(
            backup.backup_name,
            partition,
            &format!("is unreadable: {}", error.message()),
        )
    };
    let (_, raw) = open_manifest_payload(backup.manifest).map_err(unreadable)?;
    let source_index_name = source_index_name(&listed_keys(&raw)).map_err(unreadable)?;
    let decoded = decode_manifest_payload(&raw, &source_index_name).map_err(unreadable)?;
    let DecodedManifest::Current(manifest) = decoded else {
        return Err(damaged(
            backup.backup_name,
            partition,
            "uses an earlier layout",
        ));
    };
    let refs = manifest.file_refs();
    let lists_every_file = refs.len() == backup.files.len()
        && refs.iter().zip(backup.files).all(|(file, listed)| {
            file.bytes == listed.bytes && file.key == format!("{source_index_name}/{}", listed.key)
        });
    let checkpoint = &manifest.checkpoint;
    let agrees = lists_every_file
        && manifest.partitions.len() <= 1
        && manifest
            .partitions
            .iter()
            .all(|entry| entry.partition_id == partition)
        && checkpoint.len() == 1
        && checkpoint.first().is_some_and(|entry| {
            entry.partition_id == partition && entry.last_seq_no == backup.last_seq_no
        });
    if !agrees {
        return Err(damaged(
            backup.backup_name,
            partition,
            "disagrees with the files and the position that the backup lists",
        ));
    }
    Ok(PartitionManifest {
        manifest,
        source_index_name,
    })
}

fn restarted_manifest(
    manifest: &SegmentManifest,
    partition: u32,
    last_seq_no: u64,
    primary_term: u64,
) -> SegmentManifest {
    let term_history = match last_seq_no >= RESTORED_FIRST_SEQ_NO {
        true => vec![TermStart {
            primary_term,
            first_seq_no: RESTORED_FIRST_SEQ_NO,
        }],
        false => Vec::new(),
    };
    SegmentManifest {
        checkpoint: vec![PartitionCheckpoint {
            partition_id: partition,
            last_seq_no,
            primary_term,
            term_history: Some(term_history),
        }],
        ..manifest.clone()
    }
}

impl PartitionCopies<'_> {
    /// Returns the files of one partition of the cluster copy `index` that a backup saves, taken from a
    /// checkpoint that the engine writes into memory as this call starts, so that the files hold every write that
    /// the copy acknowledged before the call.
    ///
    /// The manifest lists that partition alone and carries no term history, because a restore starts a new one.
    ///
    /// Fails with `BACKUP_DURABILITY_REQUIRED` where the engine runs without write-ahead log durability, with the
    /// partition's failure where the copy failed, and with `CONFIG_INVALID` where the index is not a cluster copy
    /// or holds no such partition.
    pub fn backup_partition(&self, index: &str, partition: u32) -> Result<PartitionBackup> {
        let state = self.engine.open_index(index)?;
        if state.log().and_then(|log| log.log_store()).is_none() {
            return Err(durability_required(&state.name, partition));
        }
        let copy = super::copy_of(&state)?;
        let archive = partition_archive(&state, copy, partition)?;
        let manifest = manifest_without_term_history(&archive.checkpoint.manifest);
        let manifest_bytes = encode_manifest(&manifest, Compression::None)?;
        let refs: Vec<FileRef> = manifest.file_refs().into_iter().cloned().collect();
        let files = refs
            .iter()
            .map(|file| {
                Ok(BackupListedFile {
                    key: listed_key(file, &state.name)?,
                    bytes: file.bytes,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(PartitionBackup {
            config: archive.config,
            manifest_bytes,
            files,
            last_seq_no: archive.position.seq_no,
            checkpoint: archive.checkpoint,
            refs,
        })
    }

    /// Replaces one partition of the cluster copy `index` with the stored files of a backup's partition, and
    /// numbers the copy's next write one above the backup's `last_seq_no` under `primary_term`.
    ///
    /// The engine checks the partition's manifest against the files that the backup lists and refuses a restore
    /// that would pass the process's memory limit before it asks `copy_file` for any file. It then asks
    /// `copy_file` to write each listed file, by its position in [`BackupPartitionFiles::files`], into a snapshot
    /// archive whose manifest holds a term history of `primary_term` alone, and it loads that archive as
    /// [`PartitionCopies::restore_partition`] does. A failure of `copy_file` leaves the partition as it was.
    ///
    /// Fails with `BACKUP_DAMAGED` where the manifest is unreadable or disagrees with the listed files or position,
    /// with `RESTORE_MEMORY_EXCEEDED` where the files would pass the memory limit, with the error of `copy_file`
    /// where it fails, and with the errors of [`PartitionCopies::restore_partition`].
    pub fn restore_backup_partition(
        &self,
        index: &str,
        partition: u32,
        primary_term: u64,
        backup: &BackupPartitionFiles<'_>,
        copy_file: &mut (dyn FnMut(usize, &mut dyn Write) -> Result<()> + Send),
    ) -> Result<()> {
        let read = read_partition_manifest(backup, partition)?;
        let footprint = backup
            .files
            .iter()
            .fold(backup.config.len() as u64, |total, file| {
                total.saturating_add(file.bytes)
            });
        require_restore_memory(index, footprint, false)?;
        let restarted =
            restarted_manifest(&read.manifest, partition, backup.last_seq_no, primary_term);
        let manifest_bytes = encode_manifest(&restarted, Compression::None)?;
        let position = CopyPosition {
            seq_no: backup.last_seq_no,
            primary_term,
        };
        let (mut reader, writer) = io::pipe().map_err(|error| {
            save_failed(format!(
                "The restore could not open a pipe for the partition archive: {error}"
            ))
        })?;
        std::thread::scope(|scope| {
            let written = scope.spawn(move || {
                let mut out = BufWriter::new(writer);
                let no_history = || Ok(None);
                let source = ArchiveSource {
                    config: backup.config,
                    manifest_bytes: &manifest_bytes,
                    manifest: &restarted,
                    source_index_name: &read.source_index_name,
                    history: &no_history,
                };
                let mut next = 0;
                let mut copy_failure = None;
                let mut copy_listed = |_: &FileRef, sink: &mut dyn Write| {
                    let at = next;
                    next += 1;
                    copy_file(at, sink).inspect_err(|error| copy_failure = Some(error.clone()))
                };
                let outcome =
                    write_snapshot_archive(&mut out, &source, &mut copy_listed).and_then(|()| {
                        out.flush().map_err(|error| {
                            save_failed(format!(
                                "The partition archive could not be written: {error}"
                            ))
                        })
                    });
                (outcome, copy_failure)
            });
            let restored = self.restore_partition(index, partition, position, &mut reader);
            drop(reader);
            let (written, copy_failure) = written.join().unwrap_or_else(|_| {
                let failed = NarsilError::new(
                    ErrorCode::INTERNAL_ERROR,
                    "The thread that wrote the partition archive failed",
                );
                (Err(failed.clone()), Some(failed))
            });
            match (copy_failure, restored, written) {
                (Some(failure), _, _) => Err(failure),
                (None, Err(error), _) => Err(error),
                (None, Ok(()), written) => written,
            }
        })
    }
}
