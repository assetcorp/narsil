use std::io::Write;

use super::Narsil;
use super::durable::archive::{archive_checkpoint, current_metadata, encoded_configuration};
use super::durable::constants::MAX_SNAPSHOT_ANALYSIS_ATTEMPTS;
use super::query_suggestions::archive::HistoryEntries;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::{ArchiveSource, write_snapshot_archive};

/// What [`Narsil::snapshot_with`] adds to the archive beyond the checkpoint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SnapshotOptions {
    /// Set this to add the popular query history of the index, which holds raw searches, so that a restore on an
    /// engine with the same key keeps the counts. Defaults to false, because a backup that holds history can keep
    /// searches past their retention.
    pub query_history: bool,
}

impl Narsil {
    /// Writes the snapshot archive of an index to `out`: a pax file holding the index's configuration and the
    /// files of one checkpoint, which any implementation of the Narsil format can restore.
    ///
    /// Under the write-ahead log, the engine first writes a checkpoint, so the archive holds every write that the
    /// engine acknowledged before the call, and it keeps that checkpoint's files until the archive is written.
    /// Otherwise the engine builds the archive's files from the index in memory.
    ///
    /// Fails with `CONFIG_INVALID` where the index's tokenizer or stop words are code, with
    /// `ANALYSIS_CHANGE_NOT_READY` where the index's analysis keeps changing while the engine writes, and with
    /// `PERSISTENCE_SAVE_FAILED` where `out` refuses the bytes.
    pub fn snapshot(&self, index: &str, out: &mut dyn Write) -> Result<()> {
        self.snapshot_with(index, out, &SnapshotOptions::default())
    }

    /// Writes the snapshot archive of an index to `out` as [`Narsil::snapshot`] does, adding what `options` asks
    /// for after the checkpoint's files.
    ///
    /// With [`SnapshotOptions::query_history`] set, the archive carries every popular query history file of the
    /// index, after the engine saves the counts of the day, so that a restore on an engine with the same key keeps
    /// the counts. Fails as [`Narsil::snapshot`] does, and with `PERSISTENCE_LOAD_FAILED` where a history file
    /// cannot be read.
    pub fn snapshot_with(
        &self,
        index: &str,
        out: &mut dyn Write,
        options: &SnapshotOptions,
    ) -> Result<()> {
        let state = self.inner.open_index(index)?;
        for _ in 0..MAX_SNAPSHOT_ANALYSIS_ATTEMPTS {
            let checkpoint = archive_checkpoint(&state)?;
            let metadata = current_metadata(&state);
            if checkpoint.manifest.analysis_generation.unwrap_or(0)
                != metadata.analysis_generation.unwrap_or(0)
            {
                continue;
            }
            let config = encoded_configuration(&state, &metadata)?;
            let entries = match options.query_history {
                true => Some(HistoryEntries::of(&self.inner, &state.name)?),
                false => None,
            };
            let history = || match &entries {
                Some(entries) => entries.next_entry(),
                None => Ok(None),
            };
            let source = ArchiveSource {
                config: &config,
                manifest_bytes: &checkpoint.manifest_bytes,
                manifest: &checkpoint.manifest,
                source_index_name: &state.name,
                history: &history,
            };
            if let Some(durable) = &self.inner.durable {
                durable.request_pass();
            }
            let mut copy = |file: &_, sink: &mut dyn Write| checkpoint.copy_file(file, sink);
            write_snapshot_archive(out, &source, &mut copy)?;
            return out.flush().map_err(|error| {
                NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!("The snapshot archive could not be written: {error}"),
                )
            });
        }
        Err(NarsilError::new(
            ErrorCode::ANALYSIS_CHANGE_NOT_READY,
            format!(
                "The analysis of index \"{}\" changed while the engine wrote its snapshot, so try the snapshot again once the change has a durable checkpoint",
                state.name
            ),
        ))
    }
}
