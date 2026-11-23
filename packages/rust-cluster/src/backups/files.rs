use std::collections::HashSet;
use std::fmt::Write as _;

use narsil::Value;
use narsil::replication::StoredFile;
use sha2::{Digest, Sha256};

use super::store::BackupStore;
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) fn hex_of(digest: &[u8]) -> String {
    let mut text = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex_of(&Sha256::digest(bytes))
}

pub(crate) fn stored_digests(store: &BackupStore) -> ClusterResult<HashSet<String>> {
    let files = &store.keys.files;
    Ok(store
        .list(files)?
        .iter()
        .filter_map(|key| key.strip_prefix(files.as_str()))
        .map(str::to_string)
        .collect())
}

pub(crate) fn first_unstored_file<'f>(
    store: &BackupStore,
    files: &[&'f StoredFile],
) -> ClusterResult<Option<&'f StoredFile>> {
    let held = stored_digests(store)?;
    Ok(files
        .iter()
        .find(|file| !held.contains(&file.sha256))
        .copied())
}

pub(crate) fn save_small_file(
    store: &BackupStore,
    bytes: &[u8],
    held: &mut HashSet<String>,
) -> ClusterResult<StoredFile> {
    let file = StoredFile {
        sha256: sha256_hex(bytes),
        bytes: bytes.len() as u64,
    };
    if !held.contains(&file.sha256) {
        store.save(&store.keys.file(&file.sha256)?, bytes)?;
        held.insert(file.sha256.clone());
    }
    Ok(file)
}

pub(crate) fn damaged_file(backup_name: &str, file: &StoredFile, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::BACKUP_DAMAGED,
        format!(
            "The file {} of backup '{backup_name}' {reason}, so the restore loads nothing",
            file.sha256
        ),
    )
    .with_detail("backupName", Value::from(backup_name))
    .with_detail("sha256", Value::from(file.sha256.as_str()))
    .with_detail("bytes", Value::from(file.bytes))
}

fn changed_while_read(sha256: &str) -> ClusterError {
    ClusterError::new(
        codes::PERSISTENCE_SAVE_FAILED,
        format!(
            "A checkpoint file changed between the two reads that stored it under {sha256}, so the backup stores nothing under that digest"
        ),
    )
    .with_detail("sha256", Value::from(sha256))
}

pub(crate) type ReadChunk<'r> = dyn Fn(u64, u64) -> ClusterResult<Vec<u8>> + Sync + 'r;

pub(crate) fn digest_of(
    read: &ReadChunk<'_>,
    bytes: u64,
    chunk_bytes: u64,
) -> ClusterResult<String> {
    let mut hash = Sha256::new();
    let mut offset = 0;
    while offset < bytes {
        let length = chunk_bytes.min(bytes - offset);
        hash.update(read(offset, length)?);
        offset += length;
    }
    Ok(hex_of(&hash.finalize()))
}

pub(crate) fn save_checked_file(
    store: &BackupStore,
    read: &ReadChunk<'_>,
    file: &StoredFile,
    chunk_bytes: u64,
) -> ClusterResult<()> {
    let key = store.keys.file(&file.sha256)?;
    let mut hash = Sha256::new();
    let mut bytes = Vec::with_capacity(usize::try_from(file.bytes).unwrap_or_default());
    let mut offset = 0;
    while offset < file.bytes {
        let chunk = read(offset, chunk_bytes.min(file.bytes - offset))?;
        hash.update(&chunk);
        offset += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        if chunk.is_empty() {
            break;
        }
    }
    if offset != file.bytes || hex_of(&hash.finalize()) != file.sha256 {
        return Err(changed_while_read(&file.sha256));
    }
    store.save(&key, &bytes)
}

pub(crate) fn load_checked_bytes(
    store: &BackupStore,
    file: &StoredFile,
    backup_name: &str,
) -> ClusterResult<Vec<u8>> {
    let key = store.keys.file(&file.sha256)?;
    let Some(bytes) = store.load(&key)? else {
        return Err(damaged_file(backup_name, file, "is missing from the store"));
    };
    let received = bytes.len() as u64;
    if received > file.bytes {
        return Err(damaged_file(
            backup_name,
            file,
            &format!("holds more than the {} bytes that it lists", file.bytes),
        ));
    }
    if received != file.bytes {
        return Err(damaged_file(
            backup_name,
            file,
            &format!("holds {received} of the {} bytes that it lists", file.bytes),
        ));
    }
    if sha256_hex(&bytes) != file.sha256 {
        return Err(damaged_file(
            backup_name,
            file,
            "differs from its SHA-256 digest",
        ));
    }
    Ok(bytes)
}
