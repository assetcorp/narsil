pub const BYTES_PER_MB: usize = 1024 * 1024;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 7700;
pub const DEFAULT_MAX_BODY_BYTES: usize = 16 * BYTES_PER_MB;
pub const DEFAULT_MAX_IMPORT_BYTES: usize = 100 * BYTES_PER_MB;
pub const MAX_LINE_BYTES: usize = 4 * BYTES_PER_MB;
pub const IMPORT_BATCH_SIZE: usize = 1000;
pub const MAX_IMPORT_ERRORS: usize = 100;
pub const MAX_RESULT_WINDOW: usize = 10_000;

pub const MAX_RETAINED_TASKS: usize = 1000;
pub const MAX_RUNNING_TASKS: usize = 4;

pub const SHUTDOWN_DRAIN_MS: u64 = 10_000;
