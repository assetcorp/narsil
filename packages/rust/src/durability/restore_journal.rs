use std::collections::BTreeSet;
use std::io;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::layout::manifest_key;
use crate::format::manifest::{DecodedManifest, decode_manifest_payload, open_manifest_payload};
use crate::util::hash::sha256_hex;

use super::checkpoint_files::manifest_keys;
use super::checkpoint_store::{AdapterStore, CheckpointStore};
use super::constants::{MAX_INDEX_NAME_LENGTH, MAX_RESTORE_JOURNAL_BYTES};
use super::files::{DurableDirectory, TEMPORARY_MARK};
use super::lock::LOCK_FILE_NAME;
use super::platform::random_token;

const RESTORE_JOURNAL_PREFIX: &str = ".swap-";
pub(crate) const RESTORE_STAGING_PREFIX: &str = ".restore-";
const RETIRED_INDEX_PREFIX: &str = ".retired-";

pub(crate) fn is_valid_index_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let first_valid = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric());
    first_valid
        && name.len() <= MAX_INDEX_NAME_LENGTH
        && !name.contains("..")
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn require_index_name(name: &str) -> Result<()> {
    if is_valid_index_name(name) {
        return Ok(());
    }
    let message = if name.is_empty() {
        "Index name must be a string of at least one character".to_string()
    } else if name.chars().count() > MAX_INDEX_NAME_LENGTH {
        format!("Index name must not exceed {MAX_INDEX_NAME_LENGTH} characters")
    } else if name.contains("..") && is_valid_index_name(&name.replace("..", "a")) {
        format!("Index name \"{name}\" must not contain \"..\"")
    } else {
        format!(
            "Index name \"{name}\" contains invalid characters; use alphanumeric, dots, hyphens, and underscores only"
        )
    };
    Err(NarsilError::new(ErrorCode::CONFIG_INVALID, message))
}

fn is_staging_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next() == Some(b'.')
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !name.contains("..")
}

pub(crate) fn journal_key(index_name: &str) -> String {
    format!(
        "{RESTORE_JOURNAL_PREFIX}{}",
        sha256_hex(index_name.as_bytes())
    )
}

pub(crate) fn unique_name(prefix: &str, what: &str) -> Result<String> {
    let token = random_token().map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!("The engine cannot name {what}: {error}"),
        )
    })?;
    Ok(format!("{prefix}{token}"))
}

pub(crate) trait RestoreStorage: Send + Sync {
    fn store(&self) -> &dyn CheckpointStore;
    fn moves_trees(&self) -> bool;
    fn move_tree(&self, from: &str, to: &str) -> Result<()>;
    fn move_key(&self, from: &str, to: &str) -> Result<()>;
    fn remove_prefix(&self, name: &str) -> Result<()>;
    fn top_level(&self) -> Result<Vec<(String, bool)>>;
}

pub(crate) fn top_level_names(directory: &DurableDirectory) -> Result<Vec<(String, bool)>> {
    let failed = |error: io::Error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The engine cannot list the durability directory \"{}\": {error}",
                directory.root().display()
            ),
        )
    };
    let entries = match std::fs::read_dir(directory.root()) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(failed(error)),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(failed)?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let is_directory = entry.file_type().map_err(failed)?.is_dir();
        names.push((name, is_directory));
    }
    names.sort();
    Ok(names)
}

impl RestoreStorage for DurableDirectory {
    fn store(&self) -> &dyn CheckpointStore {
        self
    }

    fn moves_trees(&self) -> bool {
        true
    }

    fn move_tree(&self, from: &str, to: &str) -> Result<()> {
        self.rename(from, to).map(|_| ())
    }

    fn move_key(&self, from: &str, to: &str) -> Result<()> {
        self.rename(from, to).map(|_| ())
    }

    fn remove_prefix(&self, name: &str) -> Result<()> {
        self.remove_tree(name)
    }

    fn top_level(&self) -> Result<Vec<(String, bool)>> {
        top_level_names(self)
    }
}

impl RestoreStorage for AdapterStore {
    fn store(&self) -> &dyn CheckpointStore {
        self
    }

    fn moves_trees(&self) -> bool {
        false
    }

    fn move_tree(&self, from: &str, to: &str) -> Result<()> {
        for key in self.list(&format!("{from}/"))? {
            let relative = key.strip_prefix(from).unwrap_or(&key);
            self.move_key(&key, &format!("{to}{relative}"))?;
        }
        Ok(())
    }

    fn move_key(&self, from: &str, to: &str) -> Result<()> {
        let Some(bytes) = self.read_within(from, MAX_FILE_BYTES)? else {
            return Ok(());
        };
        self.write_commit(to, &bytes)?;
        self.remove(from)
    }

    fn remove_prefix(&self, name: &str) -> Result<()> {
        for key in self.list(&format!("{name}/"))? {
            self.remove(&key)?;
        }
        Ok(())
    }

    fn top_level(&self) -> Result<Vec<(String, bool)>> {
        let mut names: Vec<(String, bool)> = self
            .list("")?
            .into_iter()
            .map(|key| match key.split_once('/') {
                Some((first, _)) => (first.to_string(), true),
                None => (key, false),
            })
            .collect();
        names.sort();
        names.dedup();
        Ok(names)
    }
}

fn corrupt_journal(key: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The restore journal \"{key}\" {reason}"),
    )
}

enum JournalReading {
    Leftover,
    Journal { index_name: String, staging: String },
}

fn read_journal(key: &str, bytes: &[u8]) -> Result<JournalReading> {
    let text = String::from_utf8_lossy(bytes);
    let (index_name, staging) = match text.split_once('\n') {
        Some((name, staging)) => (name, staging),
        None => (text.as_ref(), ""),
    };
    if key.strip_prefix(RESTORE_JOURNAL_PREFIX) != Some(sha256_hex(index_name.as_bytes()).as_str())
    {
        return Ok(JournalReading::Leftover);
    }
    if !is_valid_index_name(index_name) {
        return Err(corrupt_journal(
            key,
            "names an index that no index name can match",
        ));
    }
    let staging_name = staging.strip_suffix('/').unwrap_or("");
    if !is_staging_name(staging_name) || staging_name == LOCK_FILE_NAME {
        return Err(corrupt_journal(
            key,
            "names no staging prefix that a restore writes",
        ));
    }
    Ok(JournalReading::Journal {
        index_name: index_name.to_string(),
        staging: staging_name.to_string(),
    })
}

fn listed_keys(
    store: &dyn CheckpointStore,
    index_name: &str,
    staging: &str,
) -> Result<BTreeSet<String>> {
    let bytes = match store.read_within(&format!("{staging}/manifest"), MAX_FILE_BYTES)? {
        Some(bytes) => Some(bytes),
        None => store.read_within(&manifest_key(index_name), MAX_FILE_BYTES)?,
    };
    let Some(bytes) = bytes else {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The restore of index \"{index_name}\" lost its manifest, both from staging and from the index"
            ),
        ));
    };
    let (_, raw) = open_manifest_payload(&bytes)?;
    let DecodedManifest::Current(manifest) = decode_manifest_payload(&raw, index_name)? else {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The restore of index \"{index_name}\" staged a manifest in the layout of an earlier release"
            ),
        ));
    };
    let root = format!("{index_name}/");
    let mut keys: BTreeSet<String> = ["meta".to_string(), "manifest".to_string()].into();
    for key in manifest_keys(&manifest) {
        if let Some(relative) = key.strip_prefix(&root) {
            keys.insert(relative.to_string());
        }
    }
    Ok(keys)
}

pub(crate) fn finish_journal(
    storage: &dyn RestoreStorage,
    index_name: &str,
    staging: &str,
) -> Result<Option<String>> {
    let store = storage.store();
    let listed = listed_keys(store, index_name, staging)?;
    let staged: BTreeSet<String> = store.list(&format!("{staging}/"))?.into_iter().collect();
    let mut retired = None;
    if !staged.is_empty() && storage.moves_trees() {
        let name = unique_name(RETIRED_INDEX_PREFIX, "a retired index directory")?;
        storage.move_tree(index_name, &name)?;
        storage.move_tree(staging, index_name)?;
        retired = Some(name);
    } else {
        for key in &listed {
            let from = format!("{staging}/{key}");
            if staged.contains(&from) {
                storage.move_key(&from, &format!("{index_name}/{key}"))?;
            }
        }
    }
    let root = format!("{index_name}/");
    for key in store.list(&root)? {
        let relative = key.strip_prefix(&root).unwrap_or(&key);
        if !listed.contains(relative) {
            store.remove(&key)?;
        }
    }
    store.remove(&journal_key(index_name))?;
    Ok(retired)
}

pub(crate) fn finish_restore_journals(storage: &dyn RestoreStorage) -> Result<()> {
    let store = storage.store();
    for (name, is_prefix) in storage.top_level()? {
        if is_prefix || !name.starts_with(RESTORE_JOURNAL_PREFIX) {
            continue;
        }
        if name.contains(TEMPORARY_MARK) {
            store.remove(&name)?;
            continue;
        }
        let Some(bytes) = store.read_within(&name, MAX_RESTORE_JOURNAL_BYTES)? else {
            continue;
        };
        match read_journal(&name, &bytes)? {
            JournalReading::Leftover => store.remove(&name)?,
            JournalReading::Journal {
                index_name,
                staging,
            } => {
                finish_journal(storage, &index_name, &staging)?;
            }
        }
    }
    for (name, is_prefix) in storage.top_level()? {
        if is_prefix && is_staging_name(&name) {
            storage.remove_prefix(&name)?;
        }
    }
    Ok(())
}
