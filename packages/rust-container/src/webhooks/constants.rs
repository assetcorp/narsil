pub const MAX_QUEUED_DELIVERIES: usize = 10_000;
pub const MAX_SENDS_IN_FLIGHT: usize = 4;
pub const SEND_TIMEOUT_MS: u64 = 15_000;
pub const RETRY_DELAYS_MS: [u64; 9] = [
    5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 50_400_000, 72_000_000,
    86_400_000,
];
pub const MAX_RETRY_JITTER_FRACTION: f64 = 0.1;
pub const GONE_STATUS: u16 = 410;
pub const DELIVERY_LOAD_CONCURRENCY: usize = 16;
pub const WEBHOOK_USER_AGENT: &str = "narsil-webhooks";
pub const PERSISTENCE_RETRY_DELAY_MS: u64 = 5_000;
pub const WEBHOOK_ANSWER_BYTES_READ: usize = 0;
pub const DELIVERY_ID_BYTES: usize = 16;
