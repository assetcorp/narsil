pub const VARIABLE_PREFIX: &str = "NARSIL_";
pub const MAX_LIST_ITEMS: usize = 1_024;
pub const LARGEST_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const DEFAULT_HTTP_HOST: &str = "0.0.0.0";
pub const DEFAULT_HTTP_PORT: u64 = 7_700;
pub const MAX_HTTP_PORT: u64 = 65_535;
pub const DEFAULT_DATA_DIR: &str = "/data";
pub const DEFAULT_LANGUAGE: &str = "english";

pub const MIN_KEY_CHARACTERS: usize = 32;
pub const MIN_QUERY_SUGGESTIONS_KEY_BYTES: usize = 32;
pub const ENGINE_MAX_RERANK_WINDOW: u64 = 1_000;

pub const INDEXES_FOLDER: &str = "indexes";
pub const TASKS_FOLDER: &str = "tasks";
pub const WEBHOOKS_FOLDER: &str = "webhooks";
pub const MODELS_FOLDER: &str = "models";

pub const MAX_ADAPTER_NAME_BYTES: usize = 64;

pub const DEFAULT_ADAPTER_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_ADAPTER_MAX_RETRIES: u64 = 3;
pub const DEFAULT_RERANKER_MAX_DOCUMENTS_PER_REQUEST: u64 = 1_000;

pub const WEBHOOK_SECRET_PREFIX: &str = "whsec_";
pub const MIN_WEBHOOK_SECRET_BYTES: usize = 24;
pub const MAX_WEBHOOK_SECRET_BYTES: usize = 64;
