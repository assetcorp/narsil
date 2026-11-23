use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;

use super::build_record::new_build_id;
use super::constants::{MAX_HISTORY_FILE_BYTES, MAX_RESTORED_FILES_PER_DAY};
use super::counts_file::{OpenedCountsFile, open_counts_file};
use super::day_store::cutoff_day;
use super::history_files::{
    HistoryRead, read_history_file, restore_staging_prefix, restored_file_key,
};
use super::host::{SuggestionsOwner, wall_ms, warn};
use super::stored_state::SuggestionState;
use super::types::{QuerySuggestionsSetting, QuerySuggestionsWarningReason};
use crate::engine::EngineInner;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::QUERY_HISTORY_ARCHIVE_PREFIX;

pub(crate) struct RestoredHistory {
    owner: Arc<dyn SuggestionsOwner>,
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
    pub(crate) fn open(
        engine: &EngineInner,
        index_name: &str,
        restored: &SuggestionState,
    ) -> Result<Option<RestoredHistory>> {
        let Some(engine) = engine.self_ref.upgrade() else {
            return Ok(None);
        };
        RestoredHistory::open_for(engine, index_name, restored.setting.as_ref())
    }

    pub(crate) fn open_for(
        owner: Arc<dyn SuggestionsOwner>,
        index_name: &str,
        setting: Option<&QuerySuggestionsSetting>,
    ) -> Result<Option<RestoredHistory>> {
        let Some(setting) = setting.filter(|setting| setting.enabled) else {
            return Ok(None);
        };
        if owner.runtime().scrambler().is_none() {
            return Ok(None);
        }
        Ok(Some(RestoredHistory {
            owner,
            index_name: index_name.to_string(),
            cutoff: cutoff_day(wall_ms(), setting.resolve().retention_days),
            prefix: restore_staging_prefix(&new_build_id()?),
            staged: Vec::new(),
            received: 0,
        }))
    }

    pub(crate) fn add(&mut self, body: &mut dyn Read) -> Result<()> {
        let position = self.received;
        self.received += 1;
        let mut bytes = Vec::new();
        body.take(MAX_HISTORY_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(read_failed)?;
        let (runtime, host) = (self.owner.runtime(), self.owner.host());
        let Some(scrambler) = runtime.scrambler() else {
            return Ok(());
        };
        let opened = match open_counts_file(&bytes, None, scrambler.fingerprint()) {
            OpenedCountsFile::Counts(opened) => opened,
            unreadable => {
                let (reason, message) = match unreadable {
                    OpenedCountsFile::Damaged(message) => {
                        (QuerySuggestionsWarningReason::DamagedFile, Some(message))
                    }
                    _ => (QuerySuggestionsWarningReason::OtherKey, None),
                };
                let entry = format!("{QUERY_HISTORY_ARCHIVE_PREFIX}{position}");
                warn(host, &self.index_name, reason, Some(entry), message);
                return Ok(());
            }
        };
        if opened.day < self.cutoff {
            return Ok(());
        }
        let key = format!("{}{position}.nrsl", self.prefix);
        let index_uuid = host
            .clustered()
            .then(|| host.index_uuid(&self.index_name))
            .flatten();
        let rewritten = opened.with_index_uuid(index_uuid.as_deref())?;
        host.files().store().write_commit(&key, &rewritten)?;
        self.staged.push((key, opened.day));
        Ok(())
    }

    pub(crate) fn commit(&mut self) -> Result<()> {
        if self.received == 0 {
            return Ok(());
        }
        let (runtime, host) = (self.owner.runtime(), self.owner.host());
        runtime.discard_history(host, &self.index_name)?;
        let files = host.files().store();
        self.staged.sort_by(|left, right| left.1.cmp(&right.1));
        self.staged.reverse();
        let mut sequences: HashMap<String, usize> = HashMap::new();
        while let Some((key, day)) = self.staged.pop() {
            if let Err(error) = self.move_staged(&key, &day, &mut sequences) {
                self.staged.push((key, day));
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
        let files = self.owner.host().files().store();
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
        let files = self.owner.host().files().store();
        for (key, _) in self.staged.drain(..) {
            let _ = files.remove(&key);
        }
    }
}
