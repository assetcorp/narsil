const SYNC_EPOCH_BYTES = 16
const SYNC_EPOCH_PATTERN = /^[0-9a-f]{32}$/

export function isSyncEpoch(value: unknown): value is string {
  return typeof value === 'string' && SYNC_EPOCH_PATTERN.test(value)
}

export function newSyncEpoch(): string {
  const bytes = new Uint8Array(SYNC_EPOCH_BYTES)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
