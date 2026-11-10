use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::Arc;

use super::build_record::new_build_id;
use super::constants::{MAX_HISTORY_FILE_BYTES, MAX_RESTORED_FILES_PER_DAY};
use super::counts_file::{OpenedCountsFile, open_counts_file};
use super::days::cutoff_day;
use super::history::{HistoryRead, read_history_file, restore_staging_prefix, restored_file_key};
use super::state::SuggestionState;
use super::types::QuerySuggestionsWarningReason;
use super::warnings::warn;
use crate::durability::platform::now_ms;
use crate::engine::EngineInner;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::QUERY_HISTORY_ARCHIVE_PREFIX;

/// The history files that a snapshot archive carries for one restore, which the engine stages under a folder of
/// their own until the restored index is in place, and removes again where the restore stops first.
pub(crate) struct RestoredHistory {
    engine: Arc<EngineInner>,
    index_name: String,
    cutoff: String,
    prefix: String,
    staged: Vec<(String, String)>,
    received: usize,
}

fn read_failed(error: std::io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The snapshot archive could not be read: {error}"),
    )
}

impl RestoredHistory {
    /// Returns the sink of a restore of `index_name`, or `None` where the restored state turns the feature off or
    /// the engine has no key, since the engine then keeps no history of the index.
    pub(crate) fn open(
        engine: &EngineInner,
        index_name: &str,
        restored: &SuggestionState,
    ) -> Result<Option<RestoredHistory>> {
        let Some(setting) = restored.setting.as_ref().filter(|setting| setting.enabled) else {
            return Ok(None);
        };
        if engine.suggestions.scrambler().is_none() {
            return Ok(None);
        }
        let Some(engine) = engine.self_ref.upgrade() else {
            return Ok(None);
        };
        let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
        Ok(Some(RestoredHistory {
            engine,
            index_name: index_name.to_string(),
            cutoff: cutoff_day(now, setting.resolve().retention_days),
            prefix: restore_staging_prefix(&new_build_id()?),
            staged: Vec::new(),
            received: 0,
        }))
    }

    /// Stages the history file at `position` of the archive, skipping a day that the setting no longer keeps and
    /// warning about a file that is damaged or that another key scrambled.
    pub(crate) fn add(&mut self, body: &mut dyn Read) -> Result<()> {
        let position = self.received;
        self.received += 1;
        let mut bytes = Vec::new();
        body.take(MAX_HISTORY_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(read_failed)?;
        let runtime = &self.engine.suggestions;
        let Some(scrambler) = runtime.scrambler() else {
            return Ok(());
        };
        let entry = || Some(format!("{QUERY_HISTORY_ARCHIVE_PREFIX}{position}"));
        let opened = match open_counts_file(&bytes, None, scrambler.fingerprint()) {
            OpenedCountsFile::Counts(opened) => opened,
            OpenedCountsFile::OtherKey => {
                warn(
                    &self.engine,
                    &self.index_name,
                    QuerySuggestionsWarningReason::OtherKey,
                    entry(),
                    None,
                );
                return Ok(());
            }
            OpenedCountsFile::Damaged(reason) => {
                let reason = Some(reason);
                warn(
                    &self.engine,
                    &self.index_name,
                    QuerySuggestionsWarningReason::DamagedFile,
                    entry(),
                    reason,
                );
                return Ok(());
            }
        };
        if opened.day < self.cutoff {
            return Ok(());
        }
        let key = format!("{}{position}.nrsl", self.prefix);
        let rewritten = opened.with_index_uuid(None, opened.saved_at)?;
        runtime.files(&self.engine).write_commit(&key, &rewritten)?;
        self.staged.push((key, opened.day.clone()));
        Ok(())
    }

    /// Replaces the history of the index with the staged files, in day order, then has the next count read the
    /// groups of the history again. An archive that carried no history leaves the history as it was.
    pub(crate) fn commit(&mut self) -> Result<()> {
        if self.received == 0 {
            return Ok(());
        }
        let runtime = &self.engine.suggestions;
        runtime.discard_history(&self.engine, &self.index_name)?;
        let files = runtime.files(&self.engine);
        let mut ordered = std::mem::take(&mut self.staged);
        ordered.sort_by(|left, right| left.1.cmp(&right.1));
        let mut pending: VecDeque<(String, String)> = ordered.into();
        let mut sequences: HashMap<String, usize> = HashMap::new();
        while let Some((key, day)) = pending.pop_front() {
            let moved = self.move_staged(&key, &day, &mut sequences);
            if let Err(error) = moved {
                self.staged.push((key, day));
                self.staged.extend(pending);
                return Err(error);
            }
            let _ = files.remove(&key);
        }
        runtime.days.forget_history_groups(&self.index_name);
        Ok(())
    }

    fn move_staged(
        &self,
        key: &str,
        day: &str,
        sequences: &mut HashMap<String, usize>,
    ) -> Result<()> {
        let files = self.engine.suggestions.files(&self.engine);
        let HistoryRead::Bytes(bytes) = read_history_file(files, key)? else {
            return Ok(());
        };
        let sequence = sequences.entry(day.to_string()).or_insert(0);
        if *sequence >= MAX_RESTORED_FILES_PER_DAY {
            return Ok(());
        }
        files.write_commit(&restored_file_key(&self.index_name, day, *sequence), &bytes)?;
        *sequence += 1;
        Ok(())
    }
}

impl Drop for RestoredHistory {
    fn drop(&mut self) {
        let files = self.engine.suggestions.files(&self.engine);
        for (key, _) in self.staged.drain(..) {
            let _ = files.remove(&key);
        }
    }
}
