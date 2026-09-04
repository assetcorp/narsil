export const LEADERSHIP_IMBALANCE_THRESHOLD = 2
export const DEFAULT_ESTIMATED_PARTITION_BYTES = 50 * 1024 * 1024
export const REBALANCE_THRESHOLD = 0.1

export const BOOTSTRAP_CAS_ATTEMPTS = 5
export const ALLOCATION_CAS_ATTEMPTS = 5
export const ALLOCATION_RETRY_DELAY_MS = 1_000
export const TEARDOWN_CAS_ATTEMPTS = 5
export const TEARDOWN_RETRY_DELAY_MS = 500
export const TEARDOWN_RETRY_ROUNDS = 3
export const RECOVERY_CAS_ATTEMPTS = 5
export const PARTITION_STORES_TIMEOUT_MS = 5_000

export const DEFAULT_CONTROLLER_CONFIG = {
  leaseTtlMs: 15_000,
  standbyRetryMs: 5_000,
} as const

export const DEFAULT_NODE_LIFECYCLE_CONFIG = {
  bootstrapRetryBaseMs: 1_000,
  bootstrapRetryMaxMs: 5_000,
  bootstrapMaxRetries: 10,
  allocationDebounceMs: 250,
  nodeHeartbeatIntervalMs: 10_000,
} as const
