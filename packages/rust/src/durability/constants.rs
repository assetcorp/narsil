pub(crate) const DEFAULT_ASYNC_FLUSH_INTERVAL_MS: u64 = 1_000;
pub(crate) const DIRECTORY_IDENTITY_CHECK_INTERVAL_MS: u64 = 1_000;
pub(crate) const DEFAULT_CHECKPOINT_INTERVAL_MS: u64 = 300_000;
pub(crate) const DEFAULT_CHECKPOINT_MUTATION_THRESHOLD: u64 = 100_000;
pub(crate) const DEFAULT_SEGMENT_MAX_BYTES: u64 = 67_108_864;
pub(crate) const DEFAULT_COMPACTION_THRESHOLD: u32 = 12;
pub(crate) const DEFAULT_REWRITE_BYTES_PER_CHECKPOINT: u64 = 268_435_456;
pub(crate) const DIRECTORY_LOCK_ATTEMPTS: u32 = 3;
pub(crate) const DIRECTORY_LOCK_SETTLE_MS: u64 = 50;
pub(crate) const DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS: u64 = 1_000;
pub(crate) const MAX_LOCK_FILE_BYTES: u64 = 4_096;
pub(crate) const MAX_RESTORE_JOURNAL_BYTES: u64 = 4_096;
pub(crate) const MAX_INDEX_NAME_LENGTH: usize = 255;
#[cfg(windows)]
pub(crate) const HELD_FILE_RETRY_WINDOW_MS: u64 = 2_000;
#[cfg(windows)]
pub(crate) const HELD_FILE_RETRY_FIRST_PAUSE_MS: u64 = 1;
#[cfg(windows)]
pub(crate) const HELD_FILE_RETRY_LONGEST_PAUSE_MS: u64 = 250;
pub(crate) const SINGLE_NODE_PRIMARY_TERM: u64 = 1;
