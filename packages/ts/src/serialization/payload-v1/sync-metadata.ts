import { ErrorCodes, isSyncEpoch, NarsilError } from '#platform/storage-host'
import type { IndexMetadata, StoredChangesSetting, StoredSyncSetting } from '../../types/internal'

export interface RawSyncMetadata {
  sync?: unknown
  sync_active?: unknown
  sync_epoch?: unknown
  changes?: unknown
}

function invalid(message: string, details: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The device sync state in the index metadata ${message}`, details)
}

function invalidChanges(message: string, details: Record<string, unknown>): never {
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The change capture setting in the index metadata ${message}`,
    details,
  )
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function historyLimitsToWire(setting: { historyMaxAgeMs?: number; historyMaxBytes?: number }) {
  return {
    ...(setting.historyMaxAgeMs !== undefined ? { history_max_age_ms: setting.historyMaxAgeMs } : {}),
    ...(setting.historyMaxBytes !== undefined ? { history_max_bytes: setting.historyMaxBytes } : {}),
  }
}

export function syncMetadataToWire(meta: IndexMetadata): RawSyncMetadata {
  const wire: RawSyncMetadata = {}
  if (meta.sync !== undefined) {
    wire.sync = { enabled: meta.sync.enabled, ...historyLimitsToWire(meta.sync) }
  }
  if (meta.syncActive !== undefined) wire.sync_active = meta.syncActive
  if (meta.syncEpoch !== undefined) wire.sync_epoch = meta.syncEpoch
  if (meta.changes !== undefined) {
    wire.changes = {
      enabled: meta.changes.enabled,
      ...(meta.changes.previousDocument !== undefined ? { previous_document: meta.changes.previousDocument } : {}),
      ...historyLimitsToWire(meta.changes),
    }
  }
  return wire
}

function historyLimitsFromWire(
  raw: Record<string, unknown>,
  fail: (message: string, details: Record<string, unknown>) => never,
): { historyMaxAgeMs?: number; historyMaxBytes?: number } {
  const { history_max_age_ms: maxAge, history_max_bytes: maxBytes } = raw
  if (maxAge !== undefined && !isPositiveSafeInteger(maxAge)) {
    fail('holds a history age limit that is not a positive whole number', { historyMaxAgeMs: String(maxAge) })
  }
  if (maxBytes !== undefined && !isPositiveSafeInteger(maxBytes)) {
    fail('holds a history byte limit that is not a positive whole number', { historyMaxBytes: String(maxBytes) })
  }
  return {
    ...(maxAge !== undefined ? { historyMaxAgeMs: maxAge } : {}),
    ...(maxBytes !== undefined ? { historyMaxBytes: maxBytes } : {}),
  }
}

function storedSyncSetting(raw: unknown): StoredSyncSetting {
  if (raw === null || typeof raw !== 'object') invalid('holds a sync setting that is not a map', {})
  const fields = raw as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean') invalid('holds a sync setting without a boolean enabled', {})
  return { enabled: fields.enabled, ...historyLimitsFromWire(fields, invalid) }
}

function storedChangesSetting(raw: unknown): StoredChangesSetting {
  if (raw === null || typeof raw !== 'object') invalidChanges('is not a map', {})
  const fields = raw as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean') invalidChanges('lacks a boolean enabled', {})
  const previousDocument = fields.previous_document
  if (previousDocument !== undefined && typeof previousDocument !== 'boolean') {
    invalidChanges('holds a previous_document that is not a boolean', {})
  }
  return {
    enabled: fields.enabled,
    ...(previousDocument !== undefined ? { previousDocument } : {}),
    ...historyLimitsFromWire(fields, invalidChanges),
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
  if (raw.changes !== undefined && raw.changes !== null) meta.changes = storedChangesSetting(raw.changes)
}
