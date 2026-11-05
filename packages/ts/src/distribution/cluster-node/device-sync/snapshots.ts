import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import { estimatedArchiveBytes } from '../../../persistence/archive/range-layout'
import type { SnapshotDownload } from '../../../server/sync/serving'
import type { PartitionBounds } from '../../../sync/feed/source'
import { sha256Hex } from '../../backups/files'
import { readBackupJobs } from '../../backups/jobs'
import { type BackupManifest, storedFilesOf } from '../../backups/manifest'
import { type BackupRequestDeps, requestSyncBackup } from '../../backups/requests'
import { type BackupStore, listBackupNames, readBackupManifest } from '../../backups/store'
import type { ClusterCoordinator } from '../../coordinator/types'
import { type SpooledArchive, spoolBackupArchive } from './backup-archive'
import {
  CACHED_BACKUP_MANIFEST_LIMIT,
  DEVICE_SYNC_ARCHIVE_IDLE_MS,
  DEVICE_SYNC_BACKUP_NAME_PREFIX,
  DEVICE_SYNC_SNAPSHOT_RETRY_AFTER_MS,
} from './constants'
import { type ClusterSyncSettingDeps, markClusterSyncActive } from './settings'
import { type HeldSyncIndex, syncStateOfSettings } from './state'

export interface ClusterSnapshotDeps {
  coordinator: ClusterCoordinator
  settings: ClusterSyncSettingDeps
  store: BackupStore | null
  requests: BackupRequestDeps
  spoolDirectory: string
  bounds(indexName: string, partitionId: number): Promise<PartitionBounds>
  onError(error: unknown): void
}

export interface ClusterSnapshots {
  snapshot(indexName: string): Promise<SnapshotDownload>
  snapshotBytes(indexName: string): Promise<number>
  close(): Promise<void>
}

interface SpoolEntry {
  indexName: string
  ready: Promise<SpooledArchive>
  users: number
  lastUsedAt: number
}

function syncBackupPrefix(indexName: string): string {
  return `${DEVICE_SYNC_BACKUP_NAME_PREFIX}${sha256Hex(new TextEncoder().encode(indexName)).slice(0, 32)}-`
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
  const manifests = new Map<string, BackupManifest | null>()
  const spools = new Map<string, SpoolEntry>()
  const chosen = new Map<string, string>()
  const backingUp = new Map<string, Promise<void>>()
  let closed = false

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

  async function manifestOf(store: BackupStore, name: string): Promise<BackupManifest | null> {
    if (manifests.has(name)) return manifests.get(name) ?? null
    let read: BackupManifest | null
    try {
      read = await readBackupManifest(store, name)
    } catch (error) {
      if (!(error instanceof NarsilError)) throw error
      if (error.code !== ErrorCodes.BACKUP_DAMAGED && error.code !== ErrorCodes.BACKUP_NOT_FOUND) throw error
      read = null
    }
    if (manifests.size >= CACHED_BACKUP_MANIFEST_LIMIT) {
      const oldest = manifests.keys().next().value
      if (oldest !== undefined) manifests.delete(oldest)
    }
    manifests.set(name, read)
    return read
  }

  async function backupsOf(indexName: string, held: HeldSyncIndex, epoch: string): Promise<BackupManifest[]> {
    const store = requireStore(indexName)
    const prefix = syncBackupPrefix(indexName)
    const names = (await listBackupNames(store)).filter(
      name => name.startsWith(prefix) || !name.startsWith(DEVICE_SYNC_BACKUP_NAME_PREFIX),
    )
    const matching: BackupManifest[] = []
    for (const name of names) {
      const manifest = await manifestOf(store, name)
      if (
        manifest !== null &&
        manifest.indexName === indexName &&
        manifest.syncEpoch === epoch &&
        manifest.partitionCount === held.serving.partitionCount
      ) {
        matching.push(manifest)
      }
    }
    return matching.sort((a, b) => b.completedAt - a.completedAt || b.startedAt - a.startedAt)
  }

  async function qualifyingBackup(indexName: string, held: HeldSyncIndex, epoch: string) {
    const candidates = await backupsOf(indexName, held, epoch)
    if (candidates.length === 0) return null
    const oldest: number[] = []
    for (let partitionId = 0; partitionId < held.serving.partitionCount; partitionId++) {
      oldest.push((await deps.bounds(indexName, partitionId)).oldestSeqNo)
    }
    return (
      candidates.find(backup =>
        backup.partitions.every(partition => partition.lastSeqNo >= (oldest[partition.partitionId] ?? 0) - 1),
      ) ?? null
    )
  }

  async function startBackup(indexName: string): Promise<void> {
    if (backingUp.has(indexName) || closed) return
    for (const job of (await readBackupJobs(deps.coordinator)).values()) {
      if (job.kind === 'backup' && job.status === 'running' && job.indexName === indexName) return
    }
    if (backingUp.has(indexName)) return
    const backupName = `${syncBackupPrefix(indexName)}${generateId()}`
    const run = requestSyncBackup(deps.requests, indexName, backupName)
      .catch(deps.onError)
      .finally(() => backingUp.delete(indexName))
    backingUp.set(indexName, run)
  }

  function evictIdle(now: number): void {
    for (const [name, entry] of spools) {
      if (entry.users > 0) continue
      const superseded = chosen.get(entry.indexName) !== name
      if (!superseded && now - entry.lastUsedAt < DEVICE_SYNC_ARCHIVE_IDLE_MS) continue
      spools.delete(name)
      void entry.ready.then(archive => archive.dispose()).catch(() => undefined)
    }
  }

  function spoolOf(store: BackupStore, indexName: string, backup: BackupManifest): SpoolEntry {
    let entry = spools.get(backup.name)
    if (entry === undefined) {
      const ready = spoolBackupArchive(store, backup, deps.spoolDirectory)
      entry = { indexName, ready, users: 0, lastUsedAt: Date.now() }
      spools.set(backup.name, entry)
      const created = entry
      ready.catch(() => {
        if (spools.get(backup.name) === created) spools.delete(backup.name)
      })
    }
    return entry
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
      const backup = await qualifyingBackup(indexName, held, state.epoch)
      if (backup === null) {
        await startBackup(indexName)
        throw preparing(indexName)
      }
      chosen.set(indexName, backup.name)
      const now = Date.now()
      evictIdle(now)
      const entry = spoolOf(store, indexName, backup)
      entry.users += 1
      let archive: SpooledArchive
      try {
        archive = await entry.ready
      } catch (error) {
        entry.users -= 1
        throw error
      }
      let released = false
      return {
        entityTag: archive.entityTag,
        layout: archive.layout,
        release() {
          if (released) return
          released = true
          entry.users -= 1
          entry.lastUsedAt = Date.now()
        },
      }
    },

    async snapshotBytes(indexName) {
      const held = deps.settings.view.held(indexName)
      const state = held === undefined ? null : syncStateOfSettings(held.settings)
      if (held === undefined || state === null || deps.store === null) return 0
      const spooled = spools.get(chosen.get(indexName) ?? '')
      if (spooled !== undefined) {
        const archive = await spooled.ready.catch(() => null)
        if (archive !== null) return archive.layout.byteLength
      }
      const [newest] = await backupsOf(indexName, held, state.epoch)
      if (newest === undefined) return 0
      return estimatedArchiveBytes(storedFilesOf(newest))
    },

    async close() {
      closed = true
      await Promise.all([...backingUp.values()])
      const entries = [...spools.values()]
      spools.clear()
      await Promise.all(entries.map(entry => entry.ready.then(archive => archive.dispose()).catch(() => undefined)))
    },
  }
}
