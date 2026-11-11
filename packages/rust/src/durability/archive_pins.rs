use std::sync::Arc;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::layout::manifest_key;
use crate::format::manifest::{
    DecodedManifest, SegmentManifest, decode_manifest_payload, open_manifest_payload,
};

use super::checkpoint_files::manifest_keys;
use super::checkpoint_store::CheckpointStore;
use super::index_state::{FilePins, IndexState};
use super::snapshot_only::SnapshotStore;
use super::store::DurabilityStore;

/// The newest checkpoint of an index, whose files stay on the store until the pins drop, so that a snapshot
/// archive can copy them while later checkpoints commit.
pub(crate) struct PinnedCheckpoint {
    pub(crate) manifest_bytes: Vec<u8>,
    pub(crate) manifest: SegmentManifest,
    pub(crate) pins: FilePins,
    index_name: String,
    replacements_at_pin: u64,
}

impl PinnedCheckpoint {
    /// Refuses a read of the pinned files once a restore or a drop has replaced or removed them, because the keys
    /// that the manifest lists can then name other files. A reader calls it after each read, so that every byte
    /// it kept came from the pinned files.
    pub(crate) fn require_unreplaced(&self) -> Result<()> {
        if self.pins.replacements() == self.replacements_at_pin {
            return Ok(());
        }
        Err(save_failed(format!(
            "Index \"{}\" was dropped or restored while the engine read its checkpoint, so the read stopped",
            self.index_name
        )))
    }
}

struct HeldTurn<'a>(&'a IndexState);

impl Drop for HeldTurn<'_> {
    fn drop(&mut self) {
        self.0.checkpoint_turn.give_back();
    }
}

fn save_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_SAVE_FAILED, message)
}

/// Reads the committed manifest of `index_name` and pins every file it lists, while it holds the index's
/// checkpoint turn, so that no checkpoint removes a listed file between the read and the pin.
fn pin_checkpoint(
    store: &dyn CheckpointStore,
    state: &Arc<IndexState>,
    index_name: &str,
) -> Result<PinnedCheckpoint> {
    state.checkpoint_turn.take()?;
    let _turn = HeldTurn(state);
    let replacements_at_pin = state.replacements();
    let Some(manifest_bytes) = store.read_within(&manifest_key(index_name), MAX_FILE_BYTES)? else {
        return Err(save_failed(format!(
            "Index \"{index_name}\" holds no checkpoint"
        )));
    };
    let (_, raw) = open_manifest_payload(&manifest_bytes)?;
    let DecodedManifest::Current(manifest) = decode_manifest_payload(&raw, index_name)? else {
        return Err(save_failed(format!(
            "Index \"{index_name}\" holds an earlier layout"
        )));
    };
    let keys: Vec<String> = manifest_keys(&manifest).into_iter().collect();
    let pins = IndexState::pin(state, &keys)?;
    Ok(PinnedCheckpoint {
        manifest_bytes,
        manifest,
        pins,
        index_name: index_name.to_string(),
        replacements_at_pin,
    })
}

impl DurabilityStore {
    /// Pins the files of the newest checkpoint of `index_name`.
    pub(crate) fn pin_checkpoint(&self, index_name: &str) -> Result<PinnedCheckpoint> {
        self.inner.verify()?;
        let state = self.inner.index_state(index_name)?;
        pin_checkpoint(&self.inner.directory, &state, index_name)
    }
}

impl SnapshotStore {
    /// Pins the files of the newest checkpoint of `index_name`.
    pub(crate) fn pin_checkpoint(&self, index_name: &str) -> Result<PinnedCheckpoint> {
        let state = self.index_state(index_name)?;
        pin_checkpoint(self.store(), &state, index_name)
    }
}
