pub(crate) const DEFAULT_MAX_REOPEN_WAITERS: usize = 64;
pub(crate) const MAX_REOPEN_FAILURES: u32 = 5;
pub(crate) const REOPEN_BACKOFF_BASE_MS: u64 = 100;
pub(crate) const MAX_REOPEN_BACKOFF_EXPONENT: u32 = 16;
pub(crate) const MIN_SWEEP_INTERVAL_MS: u64 = 100;
pub(crate) const MAX_SWEEP_INTERVAL_MS: u64 = 60_000;
