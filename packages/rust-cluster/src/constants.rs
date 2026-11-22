pub const MAX_MESSAGE_SIZE_BYTES: usize = 67_108_864;
pub const GRPC_ENVELOPE_OVERHEAD_BYTES: usize = 1_024;
pub const GRPC_KEEPALIVE_TIME_MS: u64 = 30_000;
pub const GRPC_KEEPALIVE_TIMEOUT_MS: u64 = 10_000;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 5_000;
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_REPLICATION_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_SNAPSHOT_TIMEOUT_MS: u64 = 300_000;

pub const DEFAULT_TCP_PORT: u16 = 9300;
pub const DEFAULT_GRPC_PORT: u16 = 9301;
pub const DEFAULT_MAX_CONNECTIONS: usize = 256;
pub const ACCEPT_RETRY_DELAY_MS: u64 = 10;

pub const LENGTH_PREFIX_BYTES: usize = 4;
pub const FRAME_READ_CHUNK_BYTES: usize = 65_536;
pub const MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION: usize = 128;
pub const OUTBOUND_FRAME_QUEUE_LENGTH: usize = 64;
pub const STREAM_CHUNK_QUEUE_LENGTH: usize = 4;

pub const DEFAULT_ETCD_MAX_REQUEST_BYTES: usize = 1_572_864;
pub const MAX_ETCD_REQUEST_BYTES: usize = 2_147_483_647;
pub const ETCD_REQUEST_FRAMING_BYTES: usize = 1_024;
pub const ETCD_MAX_RESPONSE_BYTES: usize = 2_147_483_647;
pub const RECONNECT_FIRST_DELAY_MS: u64 = 100;
pub const RECONNECT_LONGEST_DELAY_MS: u64 = 5_000;
pub const ETCD_START_PROBE_TIMEOUT_MS: u64 = 10_000;
pub const ETCD_CALL_TIMEOUT_MS: u64 = 5_000;
pub const ETCD_KEEPALIVE_TIME_MS: u64 = 10_000;
pub const ETCD_KEEPALIVE_TIMEOUT_MS: u64 = 5_000;
pub const ETCD_WATCH_ATTACH_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_ETCD_KEY_PREFIX: &str = "_narsil";
pub const DEFAULT_ETCD_ENDPOINT: &str = "http://localhost:2379";
pub const DEFAULT_NODE_HEARTBEAT_TTL_SECONDS: u64 = 30;
pub const MAX_WATCHERS: usize = 64;
pub const CONTROLLER_LEASE_KEY: &str = "_narsil/controller";
pub const INDEX_METADATA_KEY_PREFIX: &str = "_narsil/index/";
pub const INDEX_METADATA_KEY_SUFFIX: &str = "/config";
pub const LEASE_RENEWALS_PER_TTL: u32 = 3;

/// The version of the cluster specification that this crate speaks, which a node writes into its registration.
pub const SPEC_VERSION: &str = "1.5";
pub const ETCD_ENDPOINT_FAILURE_THRESHOLD: u32 = 3;
pub const ETCD_ENDPOINT_SKIP_MS: u64 = 5_000;
pub const ETCD_CALL_RETRIES: u32 = 3;
pub const MAX_NODE_ID_LENGTH: usize = 255;
pub const DEFAULT_CAPACITY_MEMORY_BYTES: u64 = 8_000_000_000;
pub const DEFAULT_CAPACITY_CPU_CORES: u64 = 4;

pub const ESTIMATED_PARTITION_BYTES: f64 = 52_428_800.0;
pub const BALANCE_THROTTLE_FACTOR: f64 = 1.2;
pub const REBALANCE_THRESHOLD: f64 = 0.1;
pub const LEADERSHIP_IMBALANCE_THRESHOLD: f64 = 2.0;

pub const DEFAULT_CONTROLLER_LEASE_TTL_MS: u64 = 15_000;
pub const DEFAULT_STANDBY_RETRY_MS: u64 = 5_000;
pub const DEFAULT_NODE_LEFT_DELAY_MS: u64 = 60_000;
pub const DEFAULT_NODE_HEARTBEAT_INTERVAL_MS: u64 = 10_000;
pub const ALLOCATION_DEBOUNCE_MS: u64 = 500;
pub const ALLOCATION_RETRY_DELAY_MS: u64 = 1_000;
pub const ALLOCATION_CAS_ATTEMPTS: usize = 5;
pub const BOOTSTRAP_CAS_ATTEMPTS: usize = 5;
pub const INSYNC_CAS_ATTEMPTS: usize = 5;
pub const RECOVERY_CAS_ATTEMPTS: usize = 5;
pub const TEARDOWN_CAS_ATTEMPTS: usize = 5;
pub const TEARDOWN_RETRY_DELAY_MS: u64 = 500;
pub const TEARDOWN_RETRY_ROUNDS: usize = 3;
pub const PARTITION_STORES_TIMEOUT_MS: u64 = 5_000;
pub const HOLDER_RETRY_BASE_MS: u64 = 1_000;
pub const HOLDER_RETRY_CEILING_MS: u64 = 30_000;

pub const DATA_ALLOCATION_DEBOUNCE_MS: u64 = 250;
pub const BOOTSTRAP_RETRY_BASE_MS: u64 = 1_000;
pub const BOOTSTRAP_RETRY_MAX_MS: u64 = 5_000;
pub const BOOTSTRAP_MAX_RETRIES: u32 = 10;
pub const BOOTSTRAP_RESTART_DELAY_MS: u64 = 1_000;
pub const LOST_COPY_RETRY_MS: u64 = 1_000;
pub const SYNONYM_CHUNK_BYTES: u64 = 1_048_576;
pub const SYNONYM_SET_KEY_PREFIX: &str = "_narsil/synonyms/";
pub const MAX_SYNONYM_GENERATION_LENGTH: usize = 128;
pub const MAX_SCHEMA_DEPTH: usize = 4;

pub const CHANGE_CAPTURE_SPEC_VERSION: &str = "1.5";
pub const HIDDEN_GENERATION_PREFIX: &str = "narsil-generation-";
pub const REBALANCE_RECORD_KEY_SUFFIX: &str = "/rebalance";
pub const DEFAULT_ZONE_ATTRIBUTE: &str = "zone";
pub const MAX_INDEX_NAME_LENGTH: usize = 255;
pub const MAX_INDEX_UUID_LENGTH: usize = 128;
pub const MAX_PARTITION_COUNT: f64 = 65_536.0;
pub const MAX_REPLICATION_FACTOR: f64 = 255.0;
pub const SYNC_EPOCH_HEX_DIGITS: usize = 32;
pub const MAX_DISPLAYED_VALUE_CHARS: usize = 100;
