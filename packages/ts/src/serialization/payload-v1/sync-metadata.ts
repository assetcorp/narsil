import { ErrorCodes, isSyncEpoch, NarsilError } from '#platform/storage-host'
import type { IndexMetadata, StoredSyncSetting } from '../../types/internal'

export interface RawSyncMetadata {
  sync?: unknown
  sync_active?: unknown
  sync_epoch?: unknown
}

function invalid(message: string, details: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The device sync state in the index metadata ${message}`, details)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

export function syncMetadataToWire(meta: IndexMetadata): RawSyncMetadata {
  const wire: RawSyncMetadata = {}
  if (meta.sync !== undefined) {
    wire.sync = {
      enabled: meta.sync.enabled,
      ...(meta.sync.historyMaxAgeMs !== undefined ? { history_max_age_ms: meta.sync.historyMaxAgeMs } : {}),
      ...(meta.sync.historyMaxBytes !== undefined ? { history_max_bytes: meta.sync.historyMaxBytes } : {}),
    }
  }
  if (meta.syncActive !== undefined) wire.sync_active = meta.syncActive
  if (meta.syncEpoch !== undefined) wire.sync_epoch = meta.syncEpoch
  return wire
}

function storedSyncSetting(raw: unknown): StoredSyncSetting {
  if (raw === null || typeof raw !== 'object') invalid('holds a sync setting that is not a map', {})
  const { enabled, history_max_age_ms: maxAge, history_max_bytes: maxBytes } = raw as Record<string, unknown>
  if (typeof enabled !== 'boolean') invalid('holds a sync setting without a boolean enabled', {})
  if (maxAge !== undefined && !isPositiveSafeInteger(maxAge)) {
    invalid('holds a history age limit that is not a positive whole number', { historyMaxAgeMs: String(maxAge) })
  }
  if (maxBytes !== undefined && !isPositiveSafeInteger(maxBytes)) {
    invalid('holds a history byte limit that is not a positive whole number', { historyMaxBytes: String(maxBytes) })
  }
  return {
    enabled,
    ...(maxAge !== undefined ? { historyMaxAgeMs: maxAge } : {}),
    ...(maxBytes !== undefined ? { historyMaxBytes: maxBytes } : {}),
  }
}

export function syncMetadataFromWire(raw: RawSyncMetadata, meta: IndexMetadata): void {
  if (raw.sync !== undefined && raw.sync !== null) meta.sync = storedSyncSetting(raw.sync)
  if (raw.sync_active !== undefined && raw.sync_active !== null) {
    if (typeof raw.sync_active !== 'boolean') invalid('holds a sync_active that is not a boolean', {})
    meta.syncActive = raw.sync_active
  }
  if (raw.sync_epoch !== undefined && raw.sync_epoch !== null) {
    if (!isSyncEpoch(raw.sync_epoch)) invalid('holds an epoch that is not 32 lowercase hexadecimal digits', {})
    meta.syncEpoch = raw.sync_epoch
  }
}
