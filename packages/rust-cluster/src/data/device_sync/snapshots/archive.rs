use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use narsil::replication::{
    BackupArchive, BackupArchivePartition, BackupFileReader, BackupListedFile, BackupManifest,
};
use narsil::{ErrorCode, NarsilError, Value};

use crate::backups::{BackupStore, load_checked_bytes, sha256_hex};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::generate_node_id;

const SHA256_HEX_DIGITS: usize = 64;

pub(crate) struct SpooledArchive {
    pub(crate) entity_tag: String,
    pub(crate) archive: BackupArchive,
    paths: Vec<PathBuf>,
    directory: PathBuf,
}

impl Drop for SpooledArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn damaged(backup_name: &str, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::BACKUP_DAMAGED,
        format!("Backup '{backup_name}' {reason}, so a device can't load it"),
    )
    .with_detail("backupName", Value::from(backup_name))
}

fn spool_failed(path: &Path, error: &std::io::Error) -> ClusterError {
    ClusterError::new(
        codes::PERSISTENCE_SAVE_FAILED,
        format!(
            "A backup file could not be spooled to {}: {error}",
            path.display()
        ),
    )
}

fn read_spooled(path: &Path, offset: u64, length: u64) -> narsil::Result<Vec<u8>> {
    let failed = |error: std::io::Error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!("A spooled snapshot file could not be read: {error}"),
        )
    };
    let mut file = File::open(path).map_err(failed)?;
    file.seek(SeekFrom::Start(offset)).map_err(failed)?;
    let mut bytes = vec![0u8; usize::try_from(length).unwrap_or(usize::MAX)];
    file.read_exact(&mut bytes).map_err(failed)?;
    Ok(bytes)
}

impl SpooledArchive {
    pub(crate) fn reader(self: &Arc<Self>) -> BackupFileReader {
        let archive = Arc::clone(self);
        Arc::new(move |position, offset, length| {
            let Some(path) = archive.paths.get(position) else {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_LOAD_FAILED,
                    format!("The spooled snapshot holds no file at position {position}"),
                ));
            };
            read_spooled(path, offset, length)
        })
    }
}

fn write_spooled(path: &Path, bytes: &[u8]) -> ClusterResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| spool_failed(path, &error))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| spool_failed(path, &error))
}

pub(crate) fn spool_backup_archive(
    store: &BackupStore,
    backup: &BackupManifest,
    spool_directory: &Path,
) -> ClusterResult<SpooledArchive> {
    let manifest_key = store.keys.manifest(&backup.name)?;
    let Some(manifest_bytes) = store.load(&manifest_key)? else {
        return Err(damaged(&backup.name, "lost its manifest"));
    };
    let entity_tag = sha256_hex(&manifest_bytes);
    let config = load_checked_bytes(store, &backup.config, &backup.name)?;
    let mut manifests = Vec::with_capacity(backup.partitions.len());
    let mut listed = Vec::with_capacity(backup.partitions.len());
    let mut partitions = Vec::with_capacity(backup.partitions.len());
    for partition in &backup.partitions {
        let partition_id = u32::try_from(partition.partition_id)
            .map_err(|_| damaged(&backup.name, "lists a partition ID above 4294967295"))?;
        manifests.push(load_checked_bytes(
            store,
            &partition.manifest,
            &backup.name,
        )?);
        listed.push(
            partition
                .files
                .iter()
                .map(|file| BackupListedFile {
                    key: file.key.clone(),
                    bytes: file.file.bytes,
                })
                .collect::<Vec<_>>(),
        );
        partitions.push((partition_id, partition.last_seq_no as u64));
    }
    let merged: Vec<BackupArchivePartition<'_>> = partitions
        .iter()
        .zip(&manifests)
        .zip(&listed)
        .map(
            |(((partition_id, last_seq_no), manifest), files)| BackupArchivePartition {
                partition_id: *partition_id,
                manifest,
                files,
                last_seq_no: *last_seq_no,
            },
        )
        .collect();
    let archive = BackupArchive::merge(&backup.name, config, &merged)?;
    let directory = spool_directory.join(format!("device-sync-{}", generate_node_id()?));
    std::fs::create_dir_all(&directory).map_err(|error| spool_failed(&directory, &error))?;
    let mut spooled = SpooledArchive {
        entity_tag,
        archive,
        paths: Vec::new(),
        directory,
    };
    for file in spooled.archive.files().to_vec() {
        let stored = backup
            .partitions
            .get(file.partition)
            .and_then(|partition| partition.files.get(file.listed))
            .map(|listed| listed.file.clone())
            .ok_or_else(|| damaged(&backup.name, "lists too few files"))?;
        let is_digest = stored.sha256.len() == SHA256_HEX_DIGITS
            && stored
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !is_digest {
            return Err(damaged(
                &backup.name,
                "lists a file under a malformed SHA-256",
            ));
        }
        let path = spooled.directory.join(&stored.sha256);
        if !path.exists() {
            let bytes = load_checked_bytes(store, &stored, &backup.name)?;
            write_spooled(&path, &bytes)?;
        }
        spooled.paths.push(path);
    }
    Ok(spooled)
}
