import type { BackupManifest } from '../../backups/manifest'
import type { BackupStore } from '../../backups/store'
import { type SpooledArchive, spoolBackupArchive } from './backup-archive'
import { DEVICE_SYNC_ARCHIVE_IDLE_MS } from './constants'

export interface SpoolLease {
  archive: SpooledArchive
  release(): void
}

export interface SpoolCache {
  acquire(store: BackupStore, indexName: string, backup: BackupManifest): Promise<SpoolLease>
  chosen(indexName: string): Promise<SpooledArchive | null>
  close(): Promise<void>
}

interface SpoolEntry {
  indexName: string
  ready: Promise<SpooledArchive>
  users: number
  lastUsedAt: number
}

function disposeOf(entry: SpoolEntry): Promise<void> {
  return entry.ready.then(archive => archive.dispose()).catch(() => undefined)
}

export function createSpoolCache(spoolDirectory: string, guard: () => void): SpoolCache {
  const spools = new Map<string, SpoolEntry>()
  const chosenNames = new Map<string, string>()
  let closed = false

  function evictIdle(now: number): void {
    for (const [name, entry] of spools) {
      if (entry.users > 0) continue
      const superseded = chosenNames.get(entry.indexName) !== name
      if (!superseded && now - entry.lastUsedAt < DEVICE_SYNC_ARCHIVE_IDLE_MS) continue
      spools.delete(name)
      void disposeOf(entry)
    }
  }

  function spoolOf(store: BackupStore, indexName: string, backup: BackupManifest): SpoolEntry {
    let entry = spools.get(backup.name)
    if (entry === undefined) {
      const ready = spoolBackupArchive(store, backup, spoolDirectory)
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
    async acquire(store, indexName, backup) {
      guard()
      chosenNames.set(indexName, backup.name)
      evictIdle(Date.now())
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
        archive,
        release() {
          if (released) return
          released = true
          entry.users -= 1
          entry.lastUsedAt = Date.now()
          if (closed && entry.users === 0) void disposeOf(entry)
        },
      }
    },

    async chosen(indexName) {
      const spooled = spools.get(chosenNames.get(indexName) ?? '')
      if (spooled === undefined) return null
      return spooled.ready.catch(() => null)
    },

    async close() {
      closed = true
      const idle = [...spools.values()].filter(entry => entry.users === 0)
      spools.clear()
      chosenNames.clear()
      await Promise.all(idle.map(disposeOf))
    },
  }
}
