import { requireSyncSetting } from '../../../engine/sync/operations'
import { ErrorCodes, NarsilError } from '../../../errors'
import { newSyncEpoch } from '../../../sync/epoch'
import type { StoredSyncSetting } from '../../../types/internal'
import type { SyncSetting, SyncStatus } from '../../../types/sync'
import { indexConfigKey, readIndexMetadataSnapshot, validateIndexName } from '../../cluster/index-metadata'
import { type ClusterSyncSettings, metadataWithSync } from '../../cluster/sync-settings'
import { DEVICE_SYNC_SPEC_VERSION, reachesVersion } from '../../cluster/version'
import type { ClusterCoordinator, NodeRegistration } from '../../coordinator/types'
import { MAX_SETTINGS_REPLACEMENT_ATTEMPTS, SETTINGS_CONTENTION_REASON } from '../constants'
import { refuseHiddenGeneration } from '../generation-routing'
import { syncStatusOfSettings } from './state'
import type { DeviceSyncView } from './view'

export interface ClusterSyncSettingDeps {
  coordinator: ClusterCoordinator
  view: DeviceSyncView
  hasBackupStore: boolean
  hasDurability: () => boolean
}

function indexNotFound(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
    indexName,
  })
}

export function syncNotReady(subject: string, olderNodes: string[], indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.SYNC_NOT_READY,
    `${subject} ${olderNodes.length} node(s) below specification version ${DEVICE_SYNC_SPEC_VERSION}, which can't read the log for a device feed. Try again once every node registers that version`,
    { indexName, nodeIds: [...olderNodes].sort(), minimumVersion: DEVICE_SYNC_SPEC_VERSION },
  )
}

export function registeredNodesBelowDeviceSync(nodes: readonly NodeRegistration[]): string[] {
  return nodes.filter(node => !reachesVersion(node.version, DEVICE_SYNC_SPEC_VERSION)).map(node => node.nodeId)
}

function storedSetting(setting: SyncSetting): StoredSyncSetting {
  return {
    enabled: true,
    ...(setting.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: setting.historyMaxAgeMs } : {}),
    ...(setting.historyMaxBytes !== undefined ? { historyMaxBytes: setting.historyMaxBytes } : {}),
  }
}

function nextSyncSettings(current: ClusterSyncSettings, setting: SyncSetting): ClusterSyncSettings | null {
  const wasOn = current.sync?.enabled === true && current.syncEpoch !== undefined
  if (!setting.enabled) return wasOn || current.sync !== undefined ? {} : null
  if (!wasOn) return { sync: storedSetting(setting), syncActive: false, syncEpoch: newSyncEpoch() }
  return {
    sync: storedSetting(setting),
    ...(current.syncActive !== undefined ? { syncActive: current.syncActive } : {}),
    ...(current.syncEpoch !== undefined ? { syncEpoch: current.syncEpoch } : {}),
  }
}

export async function updateClusterSync(
  deps: ClusterSyncSettingDeps,
  indexName: string,
  value: SyncSetting,
): Promise<void> {
  refuseHiddenGeneration(indexName)
  validateIndexName(indexName)
  const setting = requireSyncSetting(value)
  if (setting.enabled) {
    if (!deps.hasDurability()) {
      throw new NarsilError(
        ErrorCodes.SYNC_DURABILITY_REQUIRED,
        `Index "${indexName}" needs write-ahead log durability on every node for device sync, because the feed reads the log`,
        { indexName },
      )
    }
    if (!deps.hasBackupStore) {
      throw new NarsilError(
        ErrorCodes.SYNC_BACKUP_STORE_REQUIRED,
        `Device sync in a cluster needs a backup store, because a cluster node takes a device's first copy from a backup`,
        { indexName },
      )
    }
    const olderNodes = registeredNodesBelowDeviceSync(await deps.coordinator.listNodes())
    if (olderNodes.length > 0) throw syncNotReady('The cluster has', olderNodes, indexName)
  }

  for (let attempt = 1; attempt <= MAX_SETTINGS_REPLACEMENT_ATTEMPTS; attempt++) {
    const current = await readIndexMetadataSnapshot(deps.coordinator, indexName)
    if (current === null) throw indexNotFound(indexName)
    const next = nextSyncSettings(current.settings ?? {}, setting)
    if (next === null) return
    if (
      await deps.coordinator.compareAndSet(indexConfigKey(indexName), current.bytes, metadataWithSync(current, next))
    ) {
      await deps.view.refresh(indexName)
      return
    }
  }
  throw new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `Index '${indexName}' kept changing while its sync setting was replaced ${MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so the new setting was not stored. Retry the request`,
    { reason: SETTINGS_CONTENTION_REASON, indexName, attempts: MAX_SETTINGS_REPLACEMENT_ATTEMPTS },
  )
}

export async function readClusterSync(deps: ClusterSyncSettingDeps, indexName: string): Promise<SyncStatus> {
  refuseHiddenGeneration(indexName)
  validateIndexName(indexName)
  const snapshot = await readIndexMetadataSnapshot(deps.coordinator, indexName)
  if (snapshot === null) throw indexNotFound(indexName)
  return syncStatusOfSettings(snapshot.settings)
}

export async function markClusterSyncActive(deps: ClusterSyncSettingDeps, indexName: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SETTINGS_REPLACEMENT_ATTEMPTS; attempt++) {
    const current = await readIndexMetadataSnapshot(deps.coordinator, indexName)
    if (current === null) throw indexNotFound(indexName)
    const settings: ClusterSyncSettings = current.settings ?? {}
    if (settings.sync?.enabled !== true || settings.syncEpoch === undefined) {
      throw new NarsilError(ErrorCodes.SYNC_NOT_ENABLED, `Index '${indexName}' has device sync off`, { indexName })
    }
    if (settings.syncActive === true) return
    const next = metadataWithSync(current, { sync: settings.sync, syncActive: true, syncEpoch: settings.syncEpoch })
    if (await deps.coordinator.compareAndSet(indexConfigKey(indexName), current.bytes, next)) {
      await deps.view.refresh(indexName)
      return
    }
  }
  throw new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `Index '${indexName}' kept changing while a device asked for its snapshot, so ask again`,
    { reason: SETTINGS_CONTENTION_REASON, indexName, attempts: MAX_SETTINGS_REPLACEMENT_ATTEMPTS },
  )
}
