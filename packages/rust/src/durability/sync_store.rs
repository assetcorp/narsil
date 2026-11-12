use std::collections::BTreeSet;

use crate::error::Result;

use super::checkpoint_files::{manifest_keys, read_current_manifest};
use super::store::DurabilityStore;
use super::sync_files::{
    PublishedSnapshot, list_history, read_published, release_published, remove_history,
    remove_only_published, write_published,
};
use super::sync_retention::{HistoryLimits, enforce_history_limits};

impl DurabilityStore {
    fn in_checkpoint_turn<T>(
        &self,
        index_name: &str,
        action: impl FnOnce(&dyn Fn(&str) -> bool, &BTreeSet<String>) -> Result<T>,
    ) -> Result<T> {
        let inner = &self.inner;
        inner.verify()?;
        let state = inner.index_state(index_name)?;
        state.checkpoint_turn.take()?;
        let outcome = (|| {
            let pins = state.pinned()?;
            let keeps = |key: &str| pins.contains_key(key);
            let current = read_current_manifest(&inner.directory, index_name)?
                .map(|manifest| manifest_keys(&manifest))
                .unwrap_or_default();
            action(&keeps, &current)
        })();
        state.checkpoint_turn.give_back();
        inner.guard(outcome)
    }

    /// Returns the published snapshot of an index, or `None` where it has none or where its file fails to read.
    pub(crate) fn published_snapshot(&self, index_name: &str) -> Option<PublishedSnapshot> {
        read_published(&self.inner.directory, index_name)
            .ok()
            .flatten()
    }

    /// Publishes the checkpoint whose manifest is `manifest_bytes`, which the caller holds pinned, with the index
    /// configuration `config`, then deletes every file that only the previous published snapshot listed.
    pub(crate) fn publish_snapshot(
        &self,
        index_name: &str,
        config: &[u8],
        manifest_bytes: &[u8],
    ) -> Result<PublishedSnapshot> {
        let previous = self.published_snapshot(index_name);
        let next = self.inner.guard(write_published(
            &self.inner.directory,
            index_name,
            config,
            manifest_bytes,
        ))?;
        if let Some(previous) = previous {
            self.in_checkpoint_turn(index_name, |keeps, current| {
                remove_only_published(
                    &self.inner.directory,
                    &previous.keys,
                    current,
                    &next.keys,
                    keeps,
                )
            })?;
        }
        Ok(next)
    }

    /// Deletes the published snapshot of an index, with every file that only the published snapshot listed, and its
    /// history where `with_history` is set.
    pub(crate) fn release_sync_files(&self, index_name: &str, with_history: bool) -> Result<()> {
        self.in_checkpoint_turn(index_name, |keeps, current| {
            release_published(
                &self.inner.directory,
                index_name,
                current,
                keeps,
                with_history,
            )
        })
    }

    /// Deletes every history segment of an index, between checkpoints, so that no checkpoint moves a segment into
    /// history during the deletion.
    pub(crate) fn remove_history_files(&self, index_name: &str) -> Result<()> {
        if list_history(&self.inner.directory, index_name, None)?.is_empty() {
            return Ok(());
        }
        self.in_checkpoint_turn(index_name, |_, _| {
            remove_history(&self.inner.directory, index_name, None)
        })
    }

    /// Returns the length of the checkpoint of an index: the sum of the lengths of the files that its manifest
    /// lists, or 0 where it has no manifest.
    pub(crate) fn checkpoint_bytes(&self, index_name: &str) -> Result<u64> {
        Ok(
            read_current_manifest(&self.inner.directory, index_name)?.map_or(0, |manifest| {
                manifest
                    .file_refs()
                    .into_iter()
                    .map(|file| file.bytes)
                    .fold(0, u64::saturating_add)
            }),
        )
    }

    /// Reports whether a checkpoint of the index moved log segments into history since the last call.
    pub(crate) fn take_history_moved(&self, index_name: &str) -> bool {
        self.inner
            .index_state(index_name)
            .is_ok_and(|state| state.take_history_moved())
    }

    /// Deletes the oldest history segments of an index while they break `limits`, publishing a snapshot through
    /// `publish`, where one is given, first where a device that falls behind would otherwise find no snapshot to
    /// start from.
    pub(crate) fn enforce_history(
        &self,
        index_name: &str,
        limits: &HistoryLimits,
        now_ms: u64,
        publish: Option<&mut dyn FnMut() -> Result<PublishedSnapshot>>,
    ) -> Result<usize> {
        self.inner.verify()?;
        let published = self.published_snapshot(index_name);
        enforce_history_limits(
            &self.inner.directory,
            index_name,
            limits,
            now_ms,
            published,
            publish,
        )
    }
}
