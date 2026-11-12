import { ErrorCodes, NarsilError } from '../../../errors'
import { estimatedArchiveBytes } from '../../../persistence/archive/range-layout'
import type { SnapshotDownload } from '../../../server/sync/serving'
import { SYNC_BACKUP_TAKER, storedFilesOf } from '../../backups/manifest'
import type { BackupStore } from '../../backups/store'
import type { BackupCatalog } from './backup-catalog'
import { DEVICE_SYNC_SNAPSHOT_RETRY_AFTER_MS } from './constants'
import { type ClusterSyncSettingDeps, markClusterSyncActive } from './settings'
import type { SpoolCache } from './spool-cache'
import { syncStateOfSettings } from './state'

export interface ClusterSnapshotDeps {
  settings: ClusterSyncSettingDeps
  store: BackupStore | null
  catalog: BackupCatalog
  spools: SpoolCache
}

export interface ClusterSnapshots {
  snapshot(indexName: string): Promise<SnapshotDownload>
  snapshotBytes(indexName: string): Promise<number>
}

function syncOff(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.SYNC_NOT_ENABLED, `Index "${indexName}" has device sync off`, { indexName })
}

function preparing(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.SYNC_SNAPSHOT_PREPARING,
    `The cluster is taking the backup that the snapshot of index "${indexName}" needs. Ask again later`,
    { indexName, retryAfterMs: DEVICE_SYNC_SNAPSHOT_RETRY_AFTER_MS },
  )
}

export function createClusterSnapshots(deps: ClusterSnapshotDeps): ClusterSnapshots {
  const { catalog, spools } = deps

  function requireStore(indexName: string): BackupStore {
    if (deps.store === null) {
      throw new NarsilError(
        ErrorCodes.SYNC_BACKUP_STORE_REQUIRED,
        `Device sync in a cluster needs a backup store, because a cluster node takes a device's first copy from a backup`,
        { indexName },
      )
    }
    return deps.store
  }

  return {
    async snapshot(indexName) {
      let held = await deps.settings.view.current(indexName)
      const state = held === null ? null : syncStateOfSettings(held.settings)
      if (held === null || state === null) throw syncOff(indexName)
      if (!state.active) {
        await markClusterSyncActive(deps.settings, indexName)
        held = deps.settings.view.held(indexName) ?? held
      }
      const store = requireStore(indexName)
      const backup = await catalog.qualifying(store, indexName, held.serving.partitionCount, state.epoch)
      if (backup === null) {
        await catalog.startBackup(indexName, SYNC_BACKUP_TAKER)
        throw preparing(indexName)
      }
      const { archive, release } = await spools.acquire(store, indexName, backup)
      return { entityTag: archive.entityTag, layout: archive.layout, release }
    },

    async snapshotBytes(indexName) {
      const held = deps.settings.view.held(indexName)
      const state = held === undefined ? null : syncStateOfSettings(held.settings)
      if (held === undefined || state === null || deps.store === null) return 0
      const archive = await spools.chosen(indexName)
      if (archive !== null) return archive.layout.byteLength
      const [newest] = await catalog.matching(deps.store, indexName, held.serving.partitionCount, state.epoch)
      if (newest === undefined) return 0
      return estimatedArchiveBytes(storedFilesOf(newest))
    },
  }
}
