import { decode, encode } from '@msgpack/msgpack'
import type { ConfigFieldRejection } from '../../engine/snapshot/restore-config'
import { getLanguage } from '../../languages/registry'
import { isSyncEpoch } from '../../sync/epoch'
import type { StoredSyncSetting } from '../../types/internal'
import type { IndexMetadataSnapshot } from './index-metadata'
import { isRecord } from './index-settings'

export interface ClusterSyncSettings {
  sync?: StoredSyncSetting
  syncActive?: boolean
  syncEpoch?: string
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function decodeSyncSetting(raw: unknown, reject: ConfigFieldRejection): StoredSyncSetting {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean') return reject('sync must be a map with a boolean enabled')
  const { historyMaxAgeMs, historyMaxBytes } = raw
  if (historyMaxAgeMs !== undefined && !isPositiveSafeInteger(historyMaxAgeMs)) {
    return reject('sync.historyMaxAgeMs must be a positive whole number')
  }
  if (historyMaxBytes !== undefined && !isPositiveSafeInteger(historyMaxBytes)) {
    return reject('sync.historyMaxBytes must be a positive whole number')
  }
  return {
    enabled: raw.enabled,
    ...(historyMaxAgeMs !== undefined ? { historyMaxAgeMs } : {}),
    ...(historyMaxBytes !== undefined ? { historyMaxBytes } : {}),
  }
}

export function decodeClusterSyncSettings(
  raw: Record<string, unknown>,
  reject: ConfigFieldRejection,
): ClusterSyncSettings {
  const sync = raw.sync === undefined ? undefined : decodeSyncSetting(raw.sync, reject)
  if (raw.syncActive !== undefined && typeof raw.syncActive !== 'boolean') {
    return reject('syncActive must be a boolean')
  }
  if (raw.syncEpoch !== undefined && !isSyncEpoch(raw.syncEpoch)) {
    return reject('syncEpoch must be 32 lowercase hexadecimal digits')
  }
  return {
    ...(sync !== undefined ? { sync } : {}),
    ...(raw.syncActive !== undefined ? { syncActive: raw.syncActive } : {}),
    ...(raw.syncEpoch !== undefined ? { syncEpoch: raw.syncEpoch } : {}),
  }
}

export function metadataWithSync(snapshot: IndexMetadataSnapshot, next: ClusterSyncSettings): Uint8Array {
  const decoded = decode(snapshot.bytes)
  const fields = isRecord(decoded) ? decoded : {}
  const settings = isRecord(fields.settings)
    ? withoutSyncFields(fields.settings)
    : { language: snapshot.settings?.language ?? getLanguage('english').name }
  return new Uint8Array(encode({ ...fields, settings: { ...settings, ...next } }, { ignoreUndefined: true }))
}

export function withoutSyncFields(settings: Record<string, unknown>): Record<string, unknown> {
  const { sync: _sync, syncActive: _active, syncEpoch: _epoch, ...rest } = settings
  return rest
}

export function syncSettingsOfSnapshot(snapshot: IndexMetadataSnapshot): ClusterSyncSettings {
  const settings = snapshot.settings
  if (settings === undefined) return {}
  return {
    ...(settings.sync !== undefined ? { sync: settings.sync } : {}),
    ...(settings.syncActive !== undefined ? { syncActive: settings.syncActive } : {}),
    ...(settings.syncEpoch !== undefined ? { syncEpoch: settings.syncEpoch } : {}),
  }
}
