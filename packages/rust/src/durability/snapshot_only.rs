use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::format::envelope::Compression;
use crate::format::manifest::SegmentManifest;
use crate::format::manifest_refs::FileRef;
use crate::format::metadata::{IndexMetadata, write_metadata_file};

use super::checkpoint_files::{CheckpointFiles, ManifestCommitted, metadata_key, pack_commit};
use super::checkpoint_store::{AdapterStore, CheckpointStore, read_listed_payload};
use super::envelope_sink::EnvelopeSink;
use super::index_state::{IndexState, index_poisoned};
use super::persistence::PersistenceAdapter;
use super::recovery::{RecoveredIndex, index_names_in, open_stored_index};
use super::restore_journal::{
    finish_restore_journals, is_valid_index_name, journal_key, require_index_name,
};

pub(crate) struct SnapshotStore {
    store: AdapterStore,
    indexes: Mutex<HashMap<String, Arc<IndexState>>>,
}

pub(crate) struct SnapshotCheckpoint<'a> {
    state: Arc<IndexState>,
    files: CheckpointFiles<'a>,
}

impl Drop for SnapshotCheckpoint<'_> {
    fn drop(&mut self) {
        self.state.checkpoint_turn.give_back();
    }
}

impl SnapshotCheckpoint<'_> {
    pub(crate) fn prior(&self) -> Option<&SegmentManifest> {
        self.files.prior()
    }

    pub(crate) fn write_file(&mut self, key: &str, packed: &[u8]) -> Result<FileRef> {
        self.files.write_file(key, packed)
    }

    pub(crate) fn create_envelope(&mut self, key: &str, version: u8) -> Result<EnvelopeSink> {
        self.files.create_envelope(key, version)
    }

    pub(crate) fn finish_envelope(&mut self, sink: EnvelopeSink) -> Result<FileRef> {
        self.files.finish_envelope(sink)
    }

    pub(crate) fn commit(
        self,
        manifest: &SegmentManifest,
        metadata: &IndexMetadata,
        committed: &mut ManifestCommitted<'_>,
    ) -> Result<()> {
        let packed = pack_commit(self.files.index_name(), manifest, metadata)?;
        self.files.require_listed_files_present(manifest)?;
        self.files.write_manifest(&packed.manifest)?;
        committed();
        let pins = self.state.pinned()?;
        let keeps = |key: &str| pins.contains_key(key);
        self.files.remove_garbage(manifest, &keeps)?;
        let _turn = self
            .state
            .metadata_turn
            .lock()
            .map_err(|_| index_poisoned())?;
        self.files.write_metadata(&packed.metadata)
    }
}

impl SnapshotStore {
    pub(crate) fn open(adapter: Arc<dyn PersistenceAdapter>) -> Result<SnapshotStore> {
        let store = AdapterStore::new(adapter);
        finish_restore_journals(&store)?;
        Ok(SnapshotStore {
            store,
            indexes: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn store(&self) -> &AdapterStore {
        &self.store
    }

    pub(crate) fn index_state(&self, index_name: &str) -> Result<Arc<IndexState>> {
        require_index_name(index_name)?;
        let mut indexes = self.indexes.lock().map_err(|_| index_poisoned())?;
        Ok(indexes
            .entry(index_name.to_string())
            .or_insert_with(|| Arc::new(IndexState::new()))
            .clone())
    }

    pub(crate) fn index_names(&self) -> Result<Vec<String>> {
        Ok(index_names_in(self.store().list("")?))
    }

    pub(crate) fn open_index(&self, index_name: &str) -> Result<Option<RecoveredIndex>> {
        let pins = self.index_state(index_name)?.pinned()?;
        let keeps = |key: &str| pins.contains_key(key);
        open_stored_index(self.store(), index_name, &keeps)
    }

    pub(crate) fn read_listed(
        &self,
        file: &FileRef,
        what: &str,
        version: u8,
        allows_compression: bool,
    ) -> Result<Vec<u8>> {
        read_listed_payload(self.store(), file, what, version, allows_compression)
    }

    pub(crate) fn begin_checkpoint(&self, index_name: &str) -> Result<SnapshotCheckpoint<'_>> {
        let state = self.index_state(index_name)?;
        state.checkpoint_turn.take()?;
        match CheckpointFiles::open(self.store(), index_name) {
            Ok(files) => Ok(SnapshotCheckpoint { state, files }),
            Err(error) => {
                state.checkpoint_turn.give_back();
                Err(error)
            }
        }
    }

    pub(crate) fn write_metadata(&self, metadata: &IndexMetadata) -> Result<()> {
        let state = self.index_state(&metadata.index_name)?;
        let _turn = state.metadata_turn.lock().map_err(|_| index_poisoned())?;
        let bytes = write_metadata_file(metadata, Compression::None)?;
        self.store()
            .write_commit(&metadata_key(&metadata.index_name), &bytes)
    }

    pub(crate) fn remove_index(&self, index_name: &str) -> Result<()> {
        if !is_valid_index_name(index_name) {
            return Ok(());
        }
        let removed = self
            .indexes
            .lock()
            .map_err(|_| index_poisoned())?
            .remove(index_name);
        if let Some(state) = removed {
            state.mark_replaced();
        }
        let store = self.store();
        store.remove(&journal_key(index_name))?;
        for key in store.list(&format!("{index_name}/"))? {
            store.remove(&key)?;
        }
        Ok(())
    }
}
