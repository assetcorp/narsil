use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::backing::Backing;
use super::metadata::metadata_of;
use super::saved_size::SavedSize;
use crate::durability::log_segment::LogWrite;
use crate::durability::store::DurabilityStore;
use crate::engine::index::IndexState;
use crate::error::{NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::format::wal::Operation;
use crate::value::{Map, encode_document};

/// The durable record of one index: the write-ahead log that every write appends to after it applies in memory,
/// or the snapshot tier's count of writes since the last checkpoint, with the metadata facts that the index
/// recorded when it was created or recovered.
pub(crate) struct IndexLog {
    backing: Backing,
    index_name: String,
    compaction_threshold: u32,
    recorded: Mutex<IndexMetadata>,
    applied: Mutex<BTreeMap<u32, u64>>,
    unsaved_writes: AtomicU64,
    saved: Mutex<SavedSize>,
}

/// A write that failed to reach the log, with the IDs of the documents whose writes it carried.
pub(crate) struct LogFailure {
    pub(crate) error: NarsilError,
    pub(crate) doc_ids: Vec<String>,
}

impl IndexLog {
    pub(crate) fn new(
        backing: Backing,
        recorded: IndexMetadata,
        compaction_threshold: u32,
    ) -> IndexLog {
        IndexLog {
            backing,
            index_name: recorded.index_name.clone(),
            compaction_threshold,
            recorded: Mutex::new(recorded),
            applied: Mutex::new(BTreeMap::new()),
            unsaved_writes: AtomicU64::new(0),
            saved: Mutex::new(SavedSize::default()),
        }
    }

    pub(crate) fn backing(&self) -> &Backing {
        &self.backing
    }

    /// Records the saved size of the manifest that the index's files hold now.
    pub(crate) fn record_saved(&self, saved: SavedSize) {
        *self
            .saved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = saved;
    }

    /// Returns the saved size of the index's current manifest, as the last commit, recovery, or restore recorded it.
    pub(crate) fn saved_size(&self) -> SavedSize {
        self.saved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Returns the bytes that the index's log and history segments hold, or `None` under the snapshot tier.
    pub(crate) fn log_bytes(&self) -> Option<u64> {
        self.log_store().map(|store| {
            store
                .inner
                .directory
                .log_bytes()
                .index_bytes(&self.index_name)
        })
    }

    /// Returns the bytes that one partition's log and history segments hold, or `None` under the snapshot tier.
    pub(crate) fn partition_log_bytes(&self, partition_id: u32) -> Option<u64> {
        self.log_store().map(|store| {
            store
                .inner
                .directory
                .log_bytes()
                .partition_bytes(&self.index_name, partition_id)
        })
    }

    /// Returns the directory store of the write-ahead log tier, or `None` under the snapshot tier.
    pub(crate) fn log_store(&self) -> Option<&Arc<DurabilityStore>> {
        match &self.backing {
            Backing::Log(store) => Some(store),
            Backing::Snapshot(_) => None,
        }
    }

    /// Returns the number of segments that a partition holds at most before a checkpoint merges them into one.
    pub(crate) fn compaction_threshold(&self) -> u32 {
        self.compaction_threshold
    }

    /// Records the metadata that a checkpoint committed, whose facts the next metadata write keeps.
    pub(crate) fn remember(&self, metadata: IndexMetadata) {
        *self
            .recorded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = metadata;
    }

    /// Returns the metadata that `index` holds now, keeping every recorded fact that its settings do not carry.
    pub(crate) fn metadata(&self, index: &IndexState) -> IndexMetadata {
        let recorded = self
            .recorded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        metadata_of(index, &recorded)
    }

    /// Writes the metadata file of `index` as its settings stand now.
    pub(crate) fn write_metadata(&self, index: &IndexState) -> Result<()> {
        self.write_recorded(self.metadata(index))
    }

    /// Writes `metadata` as the index's metadata file, and keeps its facts for the next write.
    pub(crate) fn write_recorded(&self, metadata: IndexMetadata) -> Result<()> {
        self.backing.write_metadata(&metadata)?;
        self.remember(metadata);
        Ok(())
    }

    /// Starts the snapshot tier's numbering of each partition's writes after the checkpoint that it recovered.
    pub(crate) fn resume_after(&self, checkpoint: &[(u32, u64)]) {
        let mut applied = self
            .applied
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for &(partition_id, seq_no) in checkpoint {
            if seq_no > 0 {
                applied.insert(partition_id, seq_no);
            }
        }
    }

    /// Returns the sequence number of each partition's last write under the snapshot tier.
    pub(crate) fn applied_seq_nos(&self) -> BTreeMap<u32, u64> {
        self.applied
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Returns the number of writes that the snapshot tier holds in memory alone.
    pub(crate) fn unsaved_writes(&self) -> u64 {
        self.unsaved_writes.load(Ordering::Acquire)
    }

    /// Records that a checkpoint saved every write that the index had applied.
    pub(crate) fn checkpointed(&self) {
        self.unsaved_writes.store(0, Ordering::Release);
    }

    fn count_applied(&self, partition: u32, writes: u64) {
        let mut applied = self
            .applied
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let seq_no = applied.entry(partition).or_insert(0);
        *seq_no = seq_no.saturating_add(writes);
        self.unsaved_writes.fetch_add(writes, Ordering::AcqRel);
    }
}

/// The log records of the writes that one call applies, gathered by partition while the call holds the write lock.
pub(crate) struct PendingLog<'a> {
    log: Option<&'a IndexLog>,
    partitions: BTreeMap<u32, (Vec<LogWrite>, Vec<String>)>,
}

impl<'a> PendingLog<'a> {
    /// Starts the records of one call, refusing it before it applies anything where the log has failed.
    pub(crate) fn begin(log: Option<&'a IndexLog>) -> Result<PendingLog<'a>> {
        if let Some(log) = log
            && let Some(error) = log.backing.fatal_error()
        {
            return Err(error);
        }
        Ok(PendingLog {
            log,
            partitions: BTreeMap::new(),
        })
    }

    /// Encodes the document that an `INDEX` record carries, before the write takes its vectors out of it.
    pub(crate) fn encode(&self, document: &Map) -> Result<Option<Vec<u8>>> {
        match self.log {
            Some(log) if matches!(log.backing, Backing::Log(_)) => {
                encode_document(document).map(Some)
            }
            _ => Ok(None),
        }
    }

    fn push(&mut self, partition: u32, doc_id: &str, write: LogWrite) {
        let (writes, doc_ids) = self.partitions.entry(partition).or_default();
        writes.push(write);
        doc_ids.push(doc_id.to_string());
    }

    pub(crate) fn record_index(&mut self, partition: u32, doc_id: &str, document: Option<Vec<u8>>) {
        if self.log.is_none() {
            return;
        }
        let write = LogWrite {
            operation: Operation::Index,
            document_id: doc_id.to_string(),
            document,
        };
        self.push(partition, doc_id, write);
    }

    pub(crate) fn record_delete(&mut self, partition: u32, doc_id: &str) {
        if self.log.is_none() {
            return;
        }
        let write = LogWrite {
            operation: Operation::Delete,
            document_id: doc_id.to_string(),
            document: None,
        };
        self.push(partition, doc_id, write);
    }

    /// Appends the records of each partition, in sequence order, while the caller still holds the write lock. The
    /// snapshot tier counts them instead, for the checkpoint that saves them.
    pub(crate) fn append(self) -> AppendedLog<'a> {
        let mut appended = AppendedLog {
            log: self.log,
            waits: Vec::new(),
            failures: Vec::new(),
        };
        let Some(log) = self.log else {
            return appended;
        };
        for (partition, (writes, doc_ids)) in self.partitions {
            let store = match &log.backing {
                Backing::Log(store) => store,
                Backing::Snapshot(_) => {
                    log.count_applied(partition, writes.len() as u64);
                    continue;
                }
            };
            match store.append(&log.index_name, partition, writes) {
                Ok(done) => appended.waits.push((partition, done.last_seq_no, doc_ids)),
                Err(error) => appended.failures.push(LogFailure { error, doc_ids }),
            }
        }
        appended
    }
}

/// The records that a call appended, which reach the disk once the call waits for them outside the write lock.
pub(crate) struct AppendedLog<'a> {
    log: Option<&'a IndexLog>,
    waits: Vec<(u32, u64, Vec<String>)>,
    failures: Vec<LogFailure>,
}

impl AppendedLog<'_> {
    /// Waits until every appended record is durable, and returns each write that failed to reach the log.
    pub(crate) fn wait(self) -> Vec<LogFailure> {
        let mut failures = self.failures;
        let Some(Backing::Log(store)) = self.log.map(|log| &log.backing) else {
            return failures;
        };
        let Some(log) = self.log else {
            return failures;
        };
        for (partition, seq_no, doc_ids) in self.waits {
            if let Err(error) = store.wait_durable(&log.index_name, partition, seq_no) {
                failures.push(LogFailure { error, doc_ids });
            }
        }
        failures
    }

    /// Waits for a call that wrote one document, returning the error of its record where it failed.
    pub(crate) fn wait_for_one(self) -> Result<()> {
        match self.wait().into_iter().next() {
            Some(failure) => Err(failure.error),
            None => Ok(()),
        }
    }
}
