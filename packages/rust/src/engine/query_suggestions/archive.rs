use std::cell::Cell;

use super::history::{HistoryFileName, HistoryRead, history_files_of, read_history_file};
use crate::durability::checkpoint_store::CheckpointStore;
use crate::engine::EngineInner;
use crate::error::Result;

/// The history files of one index that a snapshot archive carries, in day order, which the archive writer takes
/// one at a time so that the engine holds one file in memory at once.
pub(crate) struct HistoryEntries<'a> {
    files: &'a dyn CheckpointStore,
    names: Vec<HistoryFileName>,
    next: Cell<usize>,
}

impl<'a> HistoryEntries<'a> {
    /// Saves the counts of the day, then lists every history file of `index_name` by day and then by key.
    pub(crate) fn of(engine: &'a EngineInner, index_name: &str) -> Result<HistoryEntries<'a>> {
        let runtime = &engine.suggestions;
        runtime.save_day(engine, index_name);
        let files = runtime.files(engine);
        let mut names = history_files_of(files, index_name)?;
        names.sort_by(|left, right| {
            left.day
                .cmp(&right.day)
                .then_with(|| left.key.cmp(&right.key))
        });
        Ok(HistoryEntries {
            files,
            names,
            next: Cell::new(0),
        })
    }

    /// Returns the bytes of the next history file, skipping each that a sweep removed or that passes the size
    /// limit, or `None` once every file is out.
    pub(crate) fn next_entry(&self) -> Result<Option<Vec<u8>>> {
        loop {
            let at = self.next.get();
            let Some(name) = self.names.get(at) else {
                return Ok(None);
            };
            self.next.set(at + 1);
            if let HistoryRead::Bytes(bytes) = read_history_file(self.files, &name.key)? {
                return Ok(Some(bytes));
            }
        }
    }
}
