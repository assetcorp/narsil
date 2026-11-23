use std::collections::BTreeSet;
use std::sync::Arc;

use super::build_record::new_build_id;
use super::constants::{QUERY_HISTORY_FOLDER, RESTORE_STAGING_INFIX};
use super::history_files::{
    HistoryRead, history_files_of, read_history_file, remove_history_folder, restore_staging_prefix,
};
use super::host::{HistoryFilesRef, SuggestionsHost};
use crate::durability::checkpoint_store::{AdapterStore, CheckpointStore};
use crate::durability::persistence::MemoryPersistence;
use crate::engine::{EngineInner, Narsil};
use crate::error::Result;

enum HistorySource {
    Engine(Arc<EngineInner>),
    Store(AdapterStore),
}

/// The store that a suggestions host keeps its query history files in: the files of a local engine, or memory.
pub struct HistoryFiles {
    source: HistorySource,
}

impl HistoryFiles {
    /// Returns the history store of `engine`: its durability files, or its memory where it keeps none.
    pub fn of_engine(engine: &Narsil) -> HistoryFiles {
        HistoryFiles {
            source: HistorySource::Engine(Arc::clone(&engine.inner)),
        }
    }

    /// Returns a history store that keeps its files in memory until it is dropped.
    pub fn in_memory() -> HistoryFiles {
        HistoryFiles {
            source: HistorySource::Store(AdapterStore::new(Arc::new(MemoryPersistence::new()))),
        }
    }

    /// Returns the store for a call of [`SuggestionsHost::files`].
    pub fn files(&self) -> HistoryFilesRef<'_> {
        match &self.source {
            HistorySource::Engine(engine) => engine.files(),
            HistorySource::Store(store) => HistoryFilesRef::new(store),
        }
    }

    fn store(&self) -> &dyn CheckpointStore {
        self.files().store()
    }

    /// Returns the bytes of the history file `key`, or `None` where the store holds no such file or one past the
    /// size limit of a history file.
    ///
    /// # Errors
    ///
    /// Fails where the store cannot read the file.
    pub fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(match read_history_file(self.store(), key)? {
            HistoryRead::Bytes(bytes) => Some(bytes),
            HistoryRead::Missing | HistoryRead::TooLong => None,
        })
    }

    /// Stores `bytes` under `key`.
    ///
    /// # Errors
    ///
    /// Fails where the store refuses the write.
    pub fn write(&self, key: &str, bytes: &[u8]) -> Result<()> {
        self.store().write_commit(key, bytes)
    }

    /// Removes the file `key`.
    ///
    /// # Errors
    ///
    /// Fails where the store refuses the removal.
    pub fn remove(&self, key: &str) -> Result<()> {
        self.store().remove(key)
    }

    /// Returns the keys of the day files of `index_name`, in code point order.
    ///
    /// # Errors
    ///
    /// Fails where the store cannot list the history folder of the index.
    pub fn day_file_keys(&self, index_name: &str) -> Result<Vec<String>> {
        let mut keys: Vec<String> = history_files_of(self.store(), index_name)?
            .into_iter()
            .map(|file| file.key)
            .collect();
        keys.sort();
        Ok(keys)
    }

    /// Returns the name of every index that holds a history folder, leaving out the folders that a restore stages.
    ///
    /// # Errors
    ///
    /// Fails where the store cannot list the history folders.
    pub fn index_names(&self) -> Result<Vec<String>> {
        let prefix = format!("{QUERY_HISTORY_FOLDER}/");
        let mut names = BTreeSet::new();
        for key in self.store().list(&prefix)? {
            let Some(rest) = key.strip_prefix(&prefix) else {
                continue;
            };
            if let Some((name, _)) = rest.split_once('/')
                && !name.is_empty()
                && !rest.starts_with(RESTORE_STAGING_INFIX)
            {
                names.insert(name.to_string());
            }
        }
        Ok(names.into_iter().collect())
    }

    /// Removes every history file of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails where the store refuses a removal.
    pub fn remove_history_folder(&self, index_name: &str) -> Result<()> {
        remove_history_folder(self.store(), index_name)
    }

    /// Returns a new folder for files that a node stages while it reads them from another node.
    ///
    /// # Errors
    ///
    /// Fails where the engine cannot draw a random folder name.
    pub fn staging_prefix() -> Result<String> {
        Ok(restore_staging_prefix(&new_build_id()?))
    }
}
