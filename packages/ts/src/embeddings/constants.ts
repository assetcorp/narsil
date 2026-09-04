export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503])
export const MAX_BACKOFF_MS = 30_000
export const BASE_BACKOFF_MS = 1_000
export const MAX_JITTER_MS = 1_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const MAX_INPUTS_PER_REQUEST = 2048
