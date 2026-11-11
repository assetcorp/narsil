use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, MutexGuard};

use crate::error::Result;

const LOG_SEGMENT_DIGITS: usize = 16;

#[derive(Default)]
struct IndexLogFiles {
    files: HashMap<String, (u32, u64)>,
    by_partition: BTreeMap<u32, u64>,
    bytes: u64,
}

impl IndexLogFiles {
    fn add(&mut self, partition_id: u32, bytes: u64) {
        self.bytes = self.bytes.saturating_add(bytes);
        let held = self.by_partition.entry(partition_id).or_insert(0);
        *held = held.saturating_add(bytes);
    }

    fn take(&mut self, partition_id: u32, bytes: u64) {
        self.bytes = self.bytes.saturating_sub(bytes);
        if let Some(held) = self.by_partition.get_mut(&partition_id) {
            *held = held.saturating_sub(bytes);
        }
    }

    fn set(&mut self, key: &str, partition_id: u32, bytes: u64) {
        if let Some((previous_partition, previous)) =
            self.files.insert(key.to_string(), (partition_id, bytes))
        {
            self.take(previous_partition, previous);
        }
        self.add(partition_id, bytes);
    }

    fn remove(&mut self, key: &str) -> Option<u64> {
        let (partition_id, bytes) = self.files.remove(key)?;
        self.take(partition_id, bytes);
        Some(bytes)
    }
}

fn is_digits(text: &str, width: usize) -> bool {
    text.len() == width && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_log_segment_name(kind: &str, name: &str) -> bool {
    match kind {
        "wal" => is_digits(name, LOG_SEGMENT_DIGITS),
        "history" => name.split_once('-').is_some_and(|(start, moved)| {
            is_digits(start, LOG_SEGMENT_DIGITS) && is_digits(moved, LOG_SEGMENT_DIGITS)
        }),
        _ => false,
    }
}

fn logged_file(key: &str) -> Option<(&str, u32)> {
    let mut parts = key.split('/');
    let index_name = parts.next()?;
    let kind = parts.next()?;
    let partition = parts.next()?;
    let name = parts.next()?;
    if parts.next().is_some() || !is_log_segment_name(kind, name) {
        return None;
    }
    if partition.is_empty() || !is_digits(partition, partition.len()) {
        return None;
    }
    let partition_id = partition.parse::<u32>().ok()?;
    Some((index_name, partition_id))
}

/// The bytes that each index's write-ahead log segments and history segments hold, which the directory updates as
/// it creates, extends, moves, and removes them, so that a stats call reads no file.
#[derive(Default)]
pub(crate) struct LogBytes {
    indexes: Mutex<HashMap<String, IndexLogFiles>>,
}

impl LogBytes {
    fn held(&self) -> MutexGuard<'_, HashMap<String, IndexLogFiles>> {
        self.indexes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records that the log or history segment under `key` holds `bytes`, and ignores every other key.
    pub(crate) fn set(&self, key: &str, bytes: u64) {
        if let Some((index_name, partition_id)) = logged_file(key) {
            self.held()
                .entry(index_name.to_string())
                .or_default()
                .set(key, partition_id, bytes);
        }
    }

    /// Forgets the segment under `key`, returning the bytes that it held.
    pub(crate) fn remove(&self, key: &str) -> Option<u64> {
        let (index_name, _) = logged_file(key)?;
        self.held().get_mut(index_name)?.remove(key)
    }

    /// Moves the bytes of the segment under `from` onto `to`, or records `measured` for `to` where `from` held none.
    pub(crate) fn moved(&self, from: &str, to: &str, measured: impl FnOnce() -> Option<u64>) {
        let carried = self.remove(from);
        if logged_file(to).is_none() {
            return;
        }
        if let Some(bytes) = carried.or_else(measured) {
            self.set(to, bytes);
        }
    }

    /// Forgets every segment under the directory `prefix`, which a removal of that whole directory deleted.
    pub(crate) fn remove_tree(&self, prefix: &str) {
        let prefix = prefix.trim_end_matches('/');
        let index_name = prefix.split('/').next().unwrap_or(prefix);
        let mut held = self.held();
        if index_name == prefix {
            held.remove(index_name);
            return;
        }
        let Some(log) = held.get_mut(index_name) else {
            return;
        };
        let inside = format!("{prefix}/");
        let removed: Vec<String> = log
            .files
            .keys()
            .filter(|key| key.starts_with(&inside))
            .cloned()
            .collect();
        for key in removed {
            log.remove(&key);
        }
    }

    /// Replaces what the ledger holds for `index_name` with the files that `measure` lists, each a key and the
    /// bytes that it holds. The ledger stays locked while `measure` reads the directory, so that an append, a move,
    /// or a removal that runs meanwhile updates the ledger after the measured figures replace it.
    pub(crate) fn seed(
        &self,
        index_name: &str,
        measure: impl FnOnce() -> Result<Vec<(String, u64)>>,
    ) -> Result<()> {
        let mut held = self.held();
        let mut log = IndexLogFiles::default();
        for (key, bytes) in measure()? {
            if let Some((owner, partition_id)) = logged_file(&key)
                && owner == index_name
            {
                log.set(&key, partition_id, bytes);
            }
        }
        held.insert(index_name.to_string(), log);
        Ok(())
    }

    /// Returns the bytes that every log and history segment of `index_name` holds.
    pub(crate) fn index_bytes(&self, index_name: &str) -> u64 {
        self.held().get(index_name).map_or(0, |log| log.bytes)
    }

    /// Returns the bytes that the log and history segments of one partition of `index_name` hold.
    pub(crate) fn partition_bytes(&self, index_name: &str, partition_id: u32) -> u64 {
        self.held()
            .get(index_name)
            .and_then(|log| log.by_partition.get(&partition_id).copied())
            .unwrap_or(0)
    }
}
