import { requireChangesSetting } from '../../../engine/changes/operations'
import { ErrorCodes, NarsilError } from '../../../errors'
import { newSyncEpoch } from '../../../sync/epoch'
import type { ChangesSetting, ChangesStatus } from '../../../types/changes'
import type { StoredChangesSetting } from '../../../types/internal'
import { indexConfigKey, readIndexMetadataSnapshot, validateIndexName } from '../../cluster/index-metadata'
import { type ClusterSyncSettings, metadataWithSync } from '../../cluster/sync-settings'
import { CHANGE_CAPTURE_SPEC_VERSION, reachesVersion } from '../../cluster/version'
import type { NodeRegistration } from '../../coordinator/types'
import { MAX_SETTINGS_REPLACEMENT_ATTEMPTS, SETTINGS_CONTENTION_REASON } from '../constants'
import { refuseHiddenGeneration } from '../generation-routing'
import type { ClusterSyncSettingDeps } from './settings'
import { changesStatusOfSettings } from './state'

function indexNotFound(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
    indexName,
  })
}

export function registeredNodesBelowChangeCapture(nodes: readonly NodeRegistration[]): string[] {
  return nodes.filter(node => !reachesVersion(node.version, CHANGE_CAPTURE_SPEC_VERSION)).map(node => node.nodeId)
}

export function changesNotReady(olderNodes: string[], indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CHANGES_NOT_READY,
    `The cluster has ${olderNodes.length} node(s) below specification version ${CHANGE_CAPTURE_SPEC_VERSION}, which keep no history for change capture. Try again once every node registers that version`,
    { indexName, nodeIds: [...olderNodes].sort(), minimumVersion: CHANGE_CAPTURE_SPEC_VERSION },
  )
}

export async function requireChangeCaptureNodes(deps: ClusterSyncSettingDeps, indexName: string): Promise<void> {
  const olderNodes = registeredNodesBelowChangeCapture(await deps.coordinator.listNodes())
  if (olderNodes.length > 0) throw changesNotReady(olderNodes, indexName)
}

function storedSetting(setting: ChangesSetting): StoredChangesSetting {
  return {
    enabled: true,
    ...(setting.previousDocument === true ? { previousDocument: true } : {}),
    ...(setting.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: setting.historyMaxAgeMs } : {}),
    ...(setting.historyMaxBytes !== undefined ? { historyMaxBytes: setting.historyMaxBytes } : {}),
  }
}

function nextChangesSettings(current: ClusterSyncSettings, setting: ChangesSetting): ClusterSyncSettings | null {
  const { changes: _changes, ...others } = current
  const syncOn = current.sync?.enabled === true && current.syncEpoch !== undefined
  const changesOn = current.changes?.enabled === true && current.syncEpoch !== undefined
  if (!setting.enabled) {
    if (current.changes === undefined) return null
    return syncOn ? others : {}
  }
  if (syncOn || changesOn) return { ...others, changes: storedSetting(setting) }
  return { ...others, changes: storedSetting(setting), syncActive: false, syncEpoch: newSyncEpoch() }
}

export async function updateClusterChanges(
  deps: ClusterSyncSettingDeps,
  indexName: string,
  value: ChangesSetting,
): Promise<void> {
  refuseHiddenGeneration(indexName)
  validateIndexName(indexName)
  const setting = requireChangesSetting(value)
  if (setting.enabled) {
    if (!deps.hasDurability()) {
      throw new NarsilError(
        ErrorCodes.CHANGES_DURABILITY_REQUIRED,
        `Index "${indexName}" needs write-ahead log durability on every node for change capture, because the feed reads the log`,
        { indexName },
      )
    }
    if (!deps.hasBackupStore) {
      throw new NarsilError(
        ErrorCodes.CHANGES_BACKUP_STORE_REQUIRED,
        'Change capture in a cluster needs a backup store, because a cluster node builds a document export from a backup',
        { indexName },
      )
    }
    await requireChangeCaptureNodes(deps, indexName)
  }

  for (let attempt = 1; attempt <= MAX_SETTINGS_REPLACEMENT_ATTEMPTS; attempt++) {
    const current = await readIndexMetadataSnapshot(deps.coordinator, indexName)
    if (current === null) throw indexNotFound(indexName)
    const next = nextChangesSettings(current.settings ?? {}, setting)
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
    `Index '${indexName}' kept changing while its changes setting was replaced ${MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so the new setting was not stored. Retry the request`,
    { reason: SETTINGS_CONTENTION_REASON, indexName, attempts: MAX_SETTINGS_REPLACEMENT_ATTEMPTS },
  )
}

export async function readClusterChanges(deps: ClusterSyncSettingDeps, indexName: string): Promise<ChangesStatus> {
  refuseHiddenGeneration(indexName)
  validateIndexName(indexName)
  const snapshot = await readIndexMetadataSnapshot(deps.coordinator, indexName)
  if (snapshot === null) throw indexNotFound(indexName)
  return changesStatusOfSettings(snapshot.settings)
}
