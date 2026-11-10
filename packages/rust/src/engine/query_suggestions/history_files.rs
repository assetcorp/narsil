use super::constants::{
    BUILD_RECORD_FILE, MAX_HISTORY_FILE_BYTES, QUERY_HISTORY_FOLDER, RESTORE_STAGING_INFIX,
    RESTORED_HISTORY_FOLDER,
};
use crate::durability::checkpoint_store::{CheckpointStore, FileLength};
use crate::error::Result;

const DAY_FILE_SUFFIX: &str = ".nrsl";
const DAY_LENGTH: usize = 10;
const RESTORED_SEQUENCE_DIGITS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistoryFileName {
    pub(crate) key: String,
    pub(crate) day: String,
}

pub(crate) enum HistoryRead {
    Missing,
    TooLong,
    Bytes(Vec<u8>),
}

fn history_folder_of(index_name: &str) -> String {
    format!("{QUERY_HISTORY_FOLDER}/{index_name}/")
}

pub(crate) fn day_file_key(index_name: &str, day: &str) -> String {
    format!("{}{day}{DAY_FILE_SUFFIX}", history_folder_of(index_name))
}

pub(crate) fn restored_file_key(index_name: &str, day: &str, sequence: usize) -> String {
    format!(
        "{}{RESTORED_HISTORY_FOLDER}/{day}-{sequence:0width$}{DAY_FILE_SUFFIX}",
        history_folder_of(index_name),
        width = RESTORED_SEQUENCE_DIGITS
    )
}

pub(crate) fn build_record_key(index_name: &str) -> String {
    format!("{}{BUILD_RECORD_FILE}", history_folder_of(index_name))
}

pub(crate) fn is_day_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == DAY_LENGTH
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

fn history_file_of(index_name: &str, key: &str) -> Option<HistoryFileName> {
    let rest = key
        .strip_prefix(&history_folder_of(index_name))?
        .strip_suffix(DAY_FILE_SUFFIX)?;
    let day = match rest.strip_prefix(RESTORED_HISTORY_FOLDER) {
        None => rest,
        Some(restored) => {
            let (day, sequence) = restored.strip_prefix('/')?.split_at_checked(DAY_LENGTH)?;
            let digits = sequence.strip_prefix('-')?;
            let numbered = digits.len() == RESTORED_SEQUENCE_DIGITS
                && digits.bytes().all(|byte| byte.is_ascii_digit());
            numbered.then_some(day)?
        }
    };
    is_day_shape(day).then(|| HistoryFileName {
        key: key.to_string(),
        day: day.to_string(),
    })
}

fn list_history_folder(store: &dyn CheckpointStore, index_name: &str) -> Result<Vec<String>> {
    store.list(&history_folder_of(index_name))
}

pub(crate) fn history_files_of(
    store: &dyn CheckpointStore,
    index_name: &str,
) -> Result<Vec<HistoryFileName>> {
    Ok(list_history_folder(store, index_name)?
        .iter()
        .filter_map(|key| history_file_of(index_name, key))
        .collect())
}

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

pub(crate) fn remove_history_folder(store: &dyn CheckpointStore, index_name: &str) -> Result<()> {
    for key in list_history_folder(store, index_name)? {
        store.remove(&key)?;
    }
    Ok(())
}

pub(crate) fn restore_staging_prefix(token: &str) -> String {
    format!("{QUERY_HISTORY_FOLDER}/{RESTORE_STAGING_INFIX}{token}/")
}

pub(crate) fn remove_restore_leftovers(store: &dyn CheckpointStore) -> Result<()> {
    for key in store.list(&format!("{QUERY_HISTORY_FOLDER}/{RESTORE_STAGING_INFIX}"))? {
        store.remove(&key)?;
    }
    Ok(())
}
