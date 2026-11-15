use std::sync::Arc;

use super::constants::SYNC_ARCHIVE_ENTRY_ESTIMATE_BYTES;
use super::{log_store_of, sync_epoch_of, sync_is_on};
use crate::durability::change_reader::{LogCursor, LogRead, LogRecord};
use crate::durability::store::DurabilityStore;
use crate::durability::sync_retention::published_archive_bytes;
use crate::engine::change_capture::ChangePosition;
use crate::engine::durable::archive::index_configuration;
use crate::engine::{EngineInner, Narsil};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Map;

const SYNC_SETTINGS_KEYS: [&str; 7] = [
    "language",
    "tokenizer",
    "stopWords",
    "stopWordList",
    "analysisRevision",
    "bm25",
    "synonyms",
];

/// What a device feed reads about a synced index, which [`Narsil::sync_feed_state`] returns.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncFeedState {
    /// The index epoch, as 32 lowercase hexadecimal digits.
    pub epoch: String,
    /// The number of partitions of the index.
    pub partition_count: u32,
    /// The settings that a device applies to its copy, under the keys of the index configuration payload:
    /// `language`, and where the index sets them, `tokenizer`, `stopWords`, `stopWordList`, `analysisRevision`,
    /// `bm25`, and `synonyms`.
    pub settings: Map,
}

/// Where the log of one partition stands, which [`Narsil::sync_bounds`] returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncBounds {
    /// The lowest sequence number that the history and the log hold, or the head plus one where they hold none.
    pub oldest_seq_no: u64,
    /// The highest sequence number that the log has made durable, the highest that a feed may send.
    pub head: u64,
    /// The highest sequence number that the partition holds, durable or not.
    pub highest_seq_no: u64,
}

/// One log entry as a device feed sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncEntry {
    /// The sequence number of the entry within its partition.
    pub seq_no: u64,
    /// The entry as the log stores it: one MessagePack replication log entry.
    pub payload: Vec<u8>,
}

/// What one read of a partition's log returned, which [`Narsil::read_sync_entries`] returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncRead {
    /// The entries above the cursor, in sequence order, which can be none.
    Entries(Vec<SyncEntry>),
    /// The history no longer holds the entry above the cursor, so the device has to load a fresh snapshot.
    HistoryGone,
}

/// Where a reader stands in one partition's history and log, keeping the segment that holds the next entry open
/// between reads.
pub struct SyncCursor {
    partition_id: u32,
    cursor: LogCursor,
}

impl SyncCursor {
    /// Returns a cursor whose next read of `partition_id` starts above `seq_no`.
    pub fn after(partition_id: u32, seq_no: u64) -> SyncCursor {
        SyncCursor {
            partition_id,
            cursor: LogCursor::after(seq_no),
        }
    }

    /// Returns the partition that the cursor reads.
    pub fn partition_id(&self) -> u32 {
        self.partition_id
    }

    /// Returns the highest sequence number that the cursor has read.
    pub fn position(&self) -> u64 {
        self.cursor.position()
    }
}

fn index_not_found(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::INDEX_NOT_FOUND,
        format!("Index \"{index_name}\" does not exist"),
    )
}

fn engine_log_store(engine: &EngineInner, index_name: &str) -> Result<Arc<DurabilityStore>> {
    if !engine.holds_index(index_name) {
        return Err(index_not_found(index_name));
    }
    engine
        .durable
        .as_ref()
        .and_then(|durable| durable.log_store())
        .cloned()
        .ok_or_else(|| {
            NarsilError::new(
                ErrorCode::SYNC_DURABILITY_REQUIRED,
                "Device sync needs write-ahead log durability",
            )
        })
}

impl Narsil {
    /// Returns the epoch, the partition count, and the device settings of a synced index, or `None` while device
    /// sync is off for it.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`.
    pub fn sync_feed_state(&self, index: &str) -> Result<Option<SyncFeedState>> {
        let state = self.inner.open_index(index)?;
        let Some(log) = state.log().filter(|log| log.log_store().is_some()) else {
            return Ok(None);
        };
        let metadata = log.metadata(&state);
        let Some(epoch) = sync_epoch_of(&metadata).filter(|_| sync_is_on(&metadata)) else {
            return Ok(None);
        };
        let configuration = index_configuration(&state, &metadata)?;
        let mut settings = Map::new();
        for key in SYNC_SETTINGS_KEYS {
            if let Some(value) = configuration.get(key) {
                settings.insert(key, value.clone());
            }
        }
        Ok(Some(SyncFeedState {
            epoch: epoch.to_string(),
            partition_count: state.partitions().len() as u32,
            settings,
        }))
    }

    /// Returns the oldest, the head, and the highest sequence number of one partition's log, opening the index
    /// where a close left it on disk, because a closed index holds no log in memory.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, and with
    /// `SYNC_DURABILITY_REQUIRED` where the engine has no write-ahead log durability.
    pub fn sync_bounds(&self, index: &str, partition_id: u32) -> Result<SyncBounds> {
        let state = self.inner.open_index(index)?;
        let store = log_store_of(&state)?;
        let positions = store.log_positions(index, partition_id)?;
        Ok(SyncBounds {
            oldest_seq_no: positions.oldest,
            head: positions.head,
            highest_seq_no: positions.highest,
        })
    }

    /// Reads the entries of the cursor's partition above the cursor and at or below `up_to`, in sequence order,
    /// while their payloads stay within `max_bytes`, and moves the cursor past them. A read always takes the first
    /// due entry, so a read of one entry can pass `max_bytes`. The read takes the entries from the log and history
    /// files alone, so it leaves a closed index closed.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, with
    /// `SYNC_DURABILITY_REQUIRED` where the engine has no write-ahead log durability, and with
    /// `PERSISTENCE_WAL_CORRUPT` where a segment is damaged.
    pub fn read_sync_entries(
        &self,
        index: &str,
        cursor: &mut SyncCursor,
        up_to: u64,
        max_bytes: usize,
    ) -> Result<SyncRead> {
        let store = engine_log_store(&self.inner, index)?;
        let keep = |record: LogRecord| {
            let bytes = record.payload.len();
            (
                SyncEntry {
                    seq_no: record.entry.seq_no as u64,
                    payload: record.payload,
                },
                bytes,
            )
        };
        let read = store.read_log_entries(
            index,
            cursor.partition_id,
            &mut cursor.cursor,
            up_to,
            max_bytes.max(1),
            &keep,
        )?;
        Ok(match read {
            LogRead::Entries(entries) => SyncRead::Entries(entries),
            LogRead::HistoryGone => SyncRead::HistoryGone,
        })
    }

    /// Returns the length in bytes of the history and log of each partition above its position, summed over the
    /// positions.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, and with
    /// `SYNC_DURABILITY_REQUIRED` where the engine has no write-ahead log durability.
    pub fn sync_bytes_behind(&self, index: &str, positions: &[ChangePosition]) -> Result<u64> {
        let store = engine_log_store(&self.inner, index)?;
        let mut bytes = 0u64;
        for position in positions {
            bytes = bytes.saturating_add(store.log_bytes_after(
                index,
                position.partition_id,
                position.seq_no,
            )?);
        }
        Ok(bytes)
    }

    /// Returns the length of the published snapshot's archive, or an estimate from the newest checkpoint where the
    /// index has published none yet.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, and with
    /// `SYNC_DURABILITY_REQUIRED` where the engine has no write-ahead log durability.
    pub fn sync_snapshot_bytes(&self, index: &str) -> Result<u64> {
        let store = engine_log_store(&self.inner, index)?;
        match store.published_snapshot(index) {
            Some(published) => Ok(published_archive_bytes(&published, index)),
            None => store.estimated_archive_bytes(index, SYNC_ARCHIVE_ENTRY_ESTIMATE_BYTES),
        }
    }

    /// Returns the path of every vector field in the schema of an index, such as `meta.embedding` for a nested
    /// field, in code point order, so that a reader without the schema can tell a vector from other binary values.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`.
    pub fn vector_fields(&self, index: &str) -> Result<Vec<String>> {
        let state = self.inner.open_index(index)?;
        let mut paths: Vec<String> = state
            .vectors
            .fields()
            .iter()
            .map(|field| field.path.clone())
            .collect();
        paths.sort_by(|left, right| left.chars().cmp(right.chars()));
        Ok(paths)
    }
}
