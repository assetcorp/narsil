use std::cell::Cell;

use super::history_files::{HistoryFileName, HistoryRead, history_files_of, read_history_file};
use crate::durability::checkpoint_store::CheckpointStore;
use crate::engine::EngineInner;
use crate::error::Result;

pub(crate) struct HistoryEntries<'a> {
    files: &'a dyn CheckpointStore,
    names: Vec<HistoryFileName>,
    next: Cell<usize>,
}

impl<'a> HistoryEntries<'a> {
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
