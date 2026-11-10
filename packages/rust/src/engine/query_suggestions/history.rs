use super::constants::{
    BUILD_RECORD_FILE, MAX_HISTORY_FILE_BYTES, QUERY_HISTORY_FOLDER, RESTORE_STAGING_INFIX,
    RESTORED_HISTORY_FOLDER,
};
use crate::durability::checkpoint_store::{CheckpointStore, FileLength};
use crate::error::Result;

const DAY_FILE_SUFFIX: &str = ".nrsl";
const DAY_LENGTH: usize = 10;
const RESTORED_SEQUENCE_DIGITS: usize = 4;

/// The name of one history file of an index: its key, its day, and whether a restore wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistoryFileName {
    pub(crate) key: String,
    pub(crate) day: String,
    pub(crate) restored: bool,
}

/// What a read of a history file found.
pub(crate) enum HistoryRead {
    Missing,
    TooLong,
    Bytes(Vec<u8>),
}

/// Returns the folder that holds the history of `index_name`, ending in `/`.
pub(crate) fn history_folder_of(index_name: &str) -> String {
    format!("{QUERY_HISTORY_FOLDER}/{index_name}/")
}

/// Returns the key of the counts of `day` that the engine itself made.
pub(crate) fn day_file_key(index_name: &str, day: &str) -> String {
    format!("{}{day}{DAY_FILE_SUFFIX}", history_folder_of(index_name))
}

/// Returns the key of the restored file `sequence` of `day`.
pub(crate) fn restored_file_key(index_name: &str, day: &str, sequence: usize) -> String {
    format!(
        "{}{RESTORED_HISTORY_FOLDER}/{day}-{sequence:0width$}{DAY_FILE_SUFFIX}",
        history_folder_of(index_name),
        width = RESTORED_SEQUENCE_DIGITS
    )
}

/// Returns the key of the record of the last build of `index_name`.
pub(crate) fn build_record_key(index_name: &str) -> String {
    format!("{}{BUILD_RECORD_FILE}", history_folder_of(index_name))
}

fn is_day_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == DAY_LENGTH
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// Reads the name of a history file of `index_name` from its key, or returns `None` for any other key.
pub(crate) fn history_file_of(index_name: &str, key: &str) -> Option<HistoryFileName> {
    let rest = key.strip_prefix(&history_folder_of(index_name))?;
    let named = |day: &str, restored: bool| HistoryFileName {
        key: key.to_string(),
        day: day.to_string(),
        restored,
    };
    if let Some(day) = rest.strip_suffix(DAY_FILE_SUFFIX)
        && is_day_shape(day)
    {
        return Some(named(day, false));
    }
    let restored = rest
        .strip_prefix(RESTORED_HISTORY_FOLDER)?
        .strip_prefix('/')?
        .strip_suffix(DAY_FILE_SUFFIX)?;
    let (day, sequence) = restored.split_at_checked(DAY_LENGTH)?;
    let digits = sequence.strip_prefix('-')?;
    let valid = is_day_shape(day)
        && digits.len() == RESTORED_SEQUENCE_DIGITS
        && digits.bytes().all(|byte| byte.is_ascii_digit());
    valid.then(|| named(day, true))
}

/// Returns every key under the history folder of `index_name`, sorted by their UTF-8 bytes.
pub(crate) fn list_history_folder(
    store: &dyn CheckpointStore,
    index_name: &str,
) -> Result<Vec<String>> {
    store.list(&history_folder_of(index_name))
}

/// Returns every history file of `index_name`, sorted by key.
pub(crate) fn history_files_of(
    store: &dyn CheckpointStore,
    index_name: &str,
) -> Result<Vec<HistoryFileName>> {
    Ok(list_history_folder(store, index_name)?
        .iter()
        .filter_map(|key| history_file_of(index_name, key))
        .collect())
}

/// Reads one history file, refusing to read one longer than a history file may be.
pub(crate) fn read_history_file(store: &dyn CheckpointStore, key: &str) -> Result<HistoryRead> {
    let limit = match store.length(key)? {
        FileLength::Missing => return Ok(HistoryRead::Missing),
        FileLength::Known(length) if length > MAX_HISTORY_FILE_BYTES => {
            return Ok(HistoryRead::TooLong);
        }
        FileLength::Known(_) => MAX_HISTORY_FILE_BYTES,
        FileLength::Unknown => u64::MAX,
    };
    Ok(match store.read_within(key, limit)? {
        None => HistoryRead::Missing,
        Some(bytes) if bytes.len() as u64 > MAX_HISTORY_FILE_BYTES => HistoryRead::TooLong,
        Some(bytes) => HistoryRead::Bytes(bytes),
    })
}

/// Deletes every key under the history folder of `index_name`.
pub(crate) fn remove_history_folder(store: &dyn CheckpointStore, index_name: &str) -> Result<()> {
    for key in list_history_folder(store, index_name)? {
        store.remove(&key)?;
    }
    Ok(())
}

/// Returns a fresh staging folder for the history files of one restore.
pub(crate) fn restore_staging_prefix(token: &str) -> String {
    format!("{QUERY_HISTORY_FOLDER}/{RESTORE_STAGING_INFIX}{token}/")
}

/// Deletes the staged history files that a restore left behind when it crashed.
pub(crate) fn remove_restore_leftovers(store: &dyn CheckpointStore) -> Result<()> {
    for key in store.list(&format!("{QUERY_HISTORY_FOLDER}/{RESTORE_STAGING_INFIX}"))? {
        store.remove(&key)?;
    }
    Ok(())
}
