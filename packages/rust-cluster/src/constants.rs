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
