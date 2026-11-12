import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionBounds } from '../../../sync/feed/source'
import { sha256Hex } from '../../backups/files'
import { readBackupJobs } from '../../backups/jobs'
import { type BackupManifest, type BackupTaker, CHANGES_BACKUP_TAKER, SYNC_BACKUP_TAKER } from '../../backups/manifest'
import { type BackupRequestDeps, requestTakenBackup } from '../../backups/requests'
import { type BackupStore, listBackupNames, readBackupManifest } from '../../backups/store'
import type { ClusterCoordinator } from '../../coordinator/types'
import { CACHED_BACKUP_MANIFEST_LIMIT } from './constants'

export interface BackupCatalogDeps {
  coordinator: ClusterCoordinator
  requests: BackupRequestDeps
  bounds(indexName: string, partitionId: number): Promise<PartitionBounds>
  onError(error: unknown): void
}

export interface BackupCatalog {
  matching(store: BackupStore, indexName: string, partitionCount: number, epoch: string): Promise<BackupManifest[]>
  qualifying(
    store: BackupStore,
    indexName: string,
    partitionCount: number,
    epoch: string,
  ): Promise<BackupManifest | null>
  startBackup(indexName: string, takenBy: BackupTaker): Promise<void>
  close(): Promise<void>
}

const TAKEN_BACKUP_NAME = new RegExp(`^(${SYNC_BACKUP_TAKER}|${CHANGES_BACKUP_TAKER})-[0-9a-f]{32}-`)

export function takenBackupPrefix(takenBy: BackupTaker, indexName: string): string {
  return `${takenBy}-${sha256Hex(new TextEncoder().encode(indexName)).slice(0, 32)}-`
}

function mayHoldIndex(name: string, indexName: string): boolean {
  const taken = TAKEN_BACKUP_NAME.exec(name)
  if (taken === null) return true
  const taker = taken[1] === CHANGES_BACKUP_TAKER ? CHANGES_BACKUP_TAKER : SYNC_BACKUP_TAKER
  return name.startsWith(takenBackupPrefix(taker, indexName))
}

export function createBackupCatalog(deps: BackupCatalogDeps): BackupCatalog {
  const manifests = new Map<string, BackupManifest | null>()
  const backingUp = new Map<string, Promise<void>>()
  let closed = false

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

  async function matching(store: BackupStore, indexName: string, partitionCount: number, epoch: string) {
    const names = (await listBackupNames(store)).filter(name => mayHoldIndex(name, indexName))
    const found: BackupManifest[] = []
    for (const name of names) {
      const manifest = await manifestOf(store, name)
      if (
        manifest !== null &&
        manifest.indexName === indexName &&
        manifest.syncEpoch === epoch &&
        manifest.partitionCount === partitionCount
      ) {
        found.push(manifest)
      }
    }
    return found.sort((a, b) => b.completedAt - a.completedAt || b.startedAt - a.startedAt)
  }

  return {
    matching,

    async qualifying(store, indexName, partitionCount, epoch) {
      const candidates = await matching(store, indexName, partitionCount, epoch)
      if (candidates.length === 0) return null
      const oldest: number[] = []
      for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
        oldest.push((await deps.bounds(indexName, partitionId)).oldestSeqNo)
      }
      const qualifies = (backup: BackupManifest): boolean => {
        const covered = new Set(backup.partitions.map(partition => partition.partitionId))
        if (covered.size !== partitionCount || oldest.some((_, partitionId) => !covered.has(partitionId))) return false
        return backup.partitions.every(partition => partition.lastSeqNo >= (oldest[partition.partitionId] ?? 0) - 1)
      }
      return candidates.find(qualifies) ?? null
    },

    async startBackup(indexName, takenBy) {
      const key = `${takenBy}\u0000${indexName}`
      if (backingUp.has(key) || closed) return
      for (const job of (await readBackupJobs(deps.coordinator)).values()) {
        if (job.kind === 'backup' && job.status === 'running' && job.indexName === indexName) return
      }
      if (backingUp.has(key) || closed) return
      const backupName = `${takenBackupPrefix(takenBy, indexName)}${generateId()}`
      const run = requestTakenBackup(deps.requests, indexName, backupName, takenBy)
        .catch(deps.onError)
        .finally(() => backingUp.delete(key))
      backingUp.set(key, run)
    },

    async close() {
      closed = true
      await Promise.all([...backingUp.values()])
    },
  }
}
