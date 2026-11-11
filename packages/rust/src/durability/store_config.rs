use std::path::PathBuf;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;

use super::constants::{
    DEFAULT_ASYNC_FLUSH_INTERVAL_MS, DEFAULT_CHECKPOINT_INTERVAL_MS,
    DEFAULT_CHECKPOINT_MUTATION_THRESHOLD, DEFAULT_SEGMENT_MAX_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DurabilityMode {
    Sync,
    Async,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoreConfig {
    pub(crate) directory: PathBuf,
    pub(crate) mode: DurabilityMode,
    pub(crate) flush_interval_ms: u64,
    pub(crate) segment_max_bytes: u64,
    pub(crate) checkpoint_interval_ms: u64,
    pub(crate) checkpoint_mutation_threshold: u64,
}

impl StoreConfig {
    pub(crate) fn new(directory: impl Into<PathBuf>) -> StoreConfig {
        StoreConfig {
            directory: directory.into(),
            mode: DurabilityMode::Sync,
            flush_interval_ms: DEFAULT_ASYNC_FLUSH_INTERVAL_MS,
            segment_max_bytes: DEFAULT_SEGMENT_MAX_BYTES,
            checkpoint_interval_ms: DEFAULT_CHECKPOINT_INTERVAL_MS,
            checkpoint_mutation_threshold: DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        let invalid = |message: String| Err(NarsilError::new(ErrorCode::CONFIG_INVALID, message));
        if self.checkpoint_mutation_threshold < 1 {
            return invalid(format!(
                "durability.checkpointMutationThreshold must be a finite number of at least 1, got {}",
                self.checkpoint_mutation_threshold
            ));
        }
        if self.segment_max_bytes < 1 {
            return invalid(format!(
                "durability.segmentMaxBytes must be a finite number of at least 1, got {}",
                self.segment_max_bytes
            ));
        }
        if self.segment_max_bytes > MAX_FILE_BYTES {
            return invalid(format!(
                "durability.segmentMaxBytes must be at most {MAX_FILE_BYTES}, the largest file that every implementation reads, got {}",
                self.segment_max_bytes
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Appended {
    pub(crate) first_seq_no: u64,
    pub(crate) last_seq_no: u64,
}
