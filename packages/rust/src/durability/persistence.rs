use std::collections::BTreeMap;
use std::path::Path;
use std::sync::RwLock;

use crate::adapters::AdapterError;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;

use super::files::DurableDirectory;

/// Stores the files of an index as byte payloads under string keys, which is how an engine without a write-ahead
/// log directory persists its checkpoints.
///
/// Such a store promises nothing beyond the last checkpoint, because a call that replaces one key at a time can
/// express neither an append nor an fsync, so a crash loses every write made since that checkpoint. The engine
/// can hold a lock of the index while it calls a method of the store, so a call from the store back into the same
/// engine on that thread can wait forever. A call to `shutdown` from a method of the store fails with
/// `CONFIG_INVALID` and changes nothing that a shutdown changes.
pub trait PersistenceAdapter: Send + Sync {
    /// Stores `data` under `key`, replacing whatever the key held.
    fn save(&self, key: &str, data: &[u8]) -> std::result::Result<(), AdapterError>;

    /// Returns the bytes stored under `key`, or `None` when the key holds nothing.
    fn load(&self, key: &str) -> std::result::Result<Option<Vec<u8>>, AdapterError>;

    /// Removes `key`. A key that holds nothing is not an error.
    fn delete(&self, key: &str) -> std::result::Result<(), AdapterError>;

    /// Returns every key that starts with `prefix`, in any order.
    fn list(&self, prefix: &str) -> std::result::Result<Vec<String>, AdapterError>;

    /// Stores `data` under `key` only where the key holds nothing, and returns `Some(Ok(true))` where it stored the
    /// data and `Some(Ok(false))` where the key already held a value. The check and the store are one atomic step
    /// against every other save of the key, and a reader sees no value or all of `data`.
    ///
    /// Returns `None` where the store offers no such step, which is the default. A cluster refuses a backup store
    /// that returns `None`, because a save followed by a load can't stop two clusters from both claiming a prefix.
    /// A store that overrides this method also overrides [`PersistenceAdapter::offers_save_if_absent`].
    fn save_if_absent(
        &self,
        _key: &str,
        _data: &[u8],
    ) -> Option<std::result::Result<bool, AdapterError>> {
        None
    }

    /// Reports whether [`PersistenceAdapter::save_if_absent`] stores data, so that a cluster node can refuse a backup
    /// store without it as the node starts. The default is false.
    fn offers_save_if_absent(&self) -> bool {
        false
    }

    /// Returns the directory that holds the keys when the store is a local directory, which lets an engine run the
    /// write-ahead log there.
    fn directory(&self) -> Option<&Path> {
        None
    }
}

/// Keeps every key in memory, which suits tests and short-lived processes, since nothing outlives the process.
#[derive(Debug, Default)]
pub struct MemoryPersistence {
    entries: RwLock<BTreeMap<String, Vec<u8>>>,
}

impl MemoryPersistence {
    /// Returns an empty store.
    pub fn new() -> MemoryPersistence {
        MemoryPersistence::default()
    }
}

fn poisoned() -> AdapterError {
    Box::new(NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        "A thread failed while it held the memory store",
    ))
}

impl PersistenceAdapter for MemoryPersistence {
    fn save(&self, key: &str, data: &[u8]) -> std::result::Result<(), AdapterError> {
        self.entries
            .write()
            .map_err(|_| poisoned())?
            .insert(key.to_string(), data.to_vec());
        Ok(())
    }

    fn load(&self, key: &str) -> std::result::Result<Option<Vec<u8>>, AdapterError> {
        Ok(self
            .entries
            .read()
            .map_err(|_| poisoned())?
            .get(key)
            .cloned())
    }

    fn delete(&self, key: &str) -> std::result::Result<(), AdapterError> {
        self.entries.write().map_err(|_| poisoned())?.remove(key);
        Ok(())
    }

    fn list(&self, prefix: &str) -> std::result::Result<Vec<String>, AdapterError> {
        Ok(self
            .entries
            .read()
            .map_err(|_| poisoned())?
            .range(prefix.to_string()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(key, _)| key.clone())
            .collect())
    }

    fn save_if_absent(
        &self,
        key: &str,
        data: &[u8],
    ) -> Option<std::result::Result<bool, AdapterError>> {
        let mut entries = match self.entries.write() {
            Ok(entries) => entries,
            Err(_) => return Some(Err(poisoned())),
        };
        if entries.contains_key(key) {
            return Some(Ok(false));
        }
        entries.insert(key.to_string(), data.to_vec());
        Some(Ok(true))
    }

    fn offers_save_if_absent(&self) -> bool {
        true
    }
}

/// Writes each key to a file under one directory, flushing it to the disk and renaming it into place, so that a
/// crash during a save leaves the previous content of the key whole.
///
/// The store refuses a key that would escape its directory.
pub struct FilesystemPersistence {
    directory: DurableDirectory,
}

impl FilesystemPersistence {
    /// Returns a store that keeps its files under `directory`, which it creates on the first save.
    ///
    /// # Errors
    ///
    /// Returns `PERSISTENCE_SAVE_FAILED` when `directory` is empty or blank.
    pub fn new(directory: impl AsRef<Path>) -> Result<FilesystemPersistence> {
        let directory = directory.as_ref();
        if directory.to_string_lossy().trim().is_empty() {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                "Filesystem persistence requires a non-empty directory path",
            ));
        }
        Ok(FilesystemPersistence {
            directory: DurableDirectory::new(directory)?,
        })
    }
}

fn boxed(error: NarsilError) -> AdapterError {
    Box::new(error)
}

impl PersistenceAdapter for FilesystemPersistence {
    fn save(&self, key: &str, data: &[u8]) -> std::result::Result<(), AdapterError> {
        self.directory.write_atomic(key, &[data]).map_err(boxed)
    }

    fn load(&self, key: &str) -> std::result::Result<Option<Vec<u8>>, AdapterError> {
        self.directory
            .read_within(key, MAX_FILE_BYTES)
            .map_err(boxed)
    }

    fn delete(&self, key: &str) -> std::result::Result<(), AdapterError> {
        self.directory.remove(key).map_err(boxed)
    }

    fn list(&self, prefix: &str) -> std::result::Result<Vec<String>, AdapterError> {
        self.directory.list(prefix).map_err(boxed)
    }

    fn save_if_absent(
        &self,
        key: &str,
        data: &[u8],
    ) -> Option<std::result::Result<bool, AdapterError>> {
        Some(self.directory.write_if_absent(key, data).map_err(boxed))
    }

    fn offers_save_if_absent(&self) -> bool {
        true
    }

    fn directory(&self) -> Option<&Path> {
        Some(self.directory.root())
    }
}
