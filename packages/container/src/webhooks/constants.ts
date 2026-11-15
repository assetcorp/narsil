export const MAX_QUEUED_DELIVERIES = 10_000
export const MAX_SENDS_IN_FLIGHT = 4
export const SEND_TIMEOUT_MS = 15_000
export const RETRY_DELAYS_MS: readonly number[] = [
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  14 * 3_600_000,
  20 * 3_600_000,
  24 * 3_600_000,
]
export const MAX_RETRY_JITTER_FRACTION = 0.1
export const GONE_STATUS = 410
export const DELIVERY_LOAD_CONCURRENCY = 16
export const WEBHOOK_USER_AGENT = 'narsil-webhooks'
