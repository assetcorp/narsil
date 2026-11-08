import { manifestReferencedKeys } from '#platform/storage-host'
import type { ArchiveCheckpoint } from '../archive-checkpoint'
import type { DurableDirectory } from '../durable-filesystem'
import { readCurrentManifest } from '../segment/load'
import type { SegmentManifest } from '../segment/manifest'
import { directoryCheckpointStore } from '../segment/store'
import { removeHistory } from './history'
import { publishedSnapshotKey, syncDirectoryPrefix } from './layout'
import { type LogRead, logBytesAfter, openPartitionLog, type PartitionLog, readPartitionLog } from './log-reader'
import { createFilePins } from './pins'
import { type PublishedSnapshot, readPublishedSnapshot, writePublishedSnapshot } from './published'
import { enforceHistoryLimits, type HistoryLimits } from './retention'

export type { HistoryLimits, LogRead, PartitionLog, PublishedSnapshot }

export interface SyncStorageDeps {
  directory: DurableDirectory
  openArchiveCheckpoint(indexName: string): Promise<ArchiveCheckpoint>
  inCheckpointTurn(indexName: string, work: () => Promise<void>): Promise<void>
}

export type SnapshotConfiguration = (manifest: SegmentManifest) => Promise<Uint8Array>

export interface SyncStorage {
  publish(indexName: string, configurationOf: SnapshotConfiguration): Promise<PublishedSnapshot>
  published(indexName: string): Promise<PublishedSnapshot | null>
  pin(snapshot: PublishedSnapshot): () => void
  readFileRange(key: string, offset: number, length: number): Promise<Uint8Array>
  release(indexName: string): Promise<void>
  removeHistory(indexName: string, partitionId?: number): Promise<void>
  enforceHistoryLimits(
    indexName: string,
    limits: HistoryLimits,
    publish: (() => Promise<void>) | null,
    nowMs: number,
  ): Promise<number>
  openPartitionLog(indexName: string, partitionId: number): Promise<PartitionLog>
  readPartitionLog(
    indexName: string,
    partitionId: number,
    afterSeqNo: number,
    upToSeqNo: number,
    maxBytes: number,
  ): Promise<LogRead>
  logBytesAfter(log: PartitionLog, afterSeqNo: number): Promise<number>
  currentManifest(indexName: string): Promise<SegmentManifest | null>
  keepsCheckpointKey(indexName: string): Promise<(key: string) => boolean>
  settleAtRecovery(indexName: string, active: boolean): Promise<ReadonlySet<string>>
  forget(indexName: string): void
}

export function createSyncStorage(deps: SyncStorageDeps): SyncStorage {
  const { directory } = deps
  const store = directoryCheckpointStore(directory)
  const cache = new Map<string, PublishedSnapshot | null>()
  const publishing = new Map<string, Promise<PublishedSnapshot>>()
  const pins = createFilePins(key => directory.remove(key))

  async function published(indexName: string): Promise<PublishedSnapshot | null> {
    const cached = cache.get(indexName)
    if (cached !== undefined) return cached
    const read = await readPublishedSnapshot(directory, indexName)
    cache.set(indexName, read)
    return read
  }

  async function removeUnlisted(indexName: string, previous: ReadonlySet<string>, kept: ReadonlySet<string>) {
    const manifest = await readCurrentManifest(store, indexName)
    const current = manifest === null ? new Set<string>() : manifestReferencedKeys(manifest)
    for (const key of previous) {
      if (kept.has(key) || current.has(key) || pins.removeWhenUnpinned(key)) continue
      await directory.remove(key)
    }
  }

  async function publishNow(indexName: string, configurationOf: SnapshotConfiguration): Promise<PublishedSnapshot> {
    const archive = await deps.openArchiveCheckpoint(indexName)
    try {
      const config = await configurationOf(archive.manifest)
      const previous = await published(indexName)
      const next = await writePublishedSnapshot(directory, indexName, config, archive.manifestBytes)
      cache.set(indexName, next)
      if (previous !== null) {
        await deps.inCheckpointTurn(indexName, () => removeUnlisted(indexName, previous.keys, next.keys))
      }
      return next
    } finally {
      archive.release()
    }
  }

  return {
    publish(indexName, configurationOf) {
      const inFlight = publishing.get(indexName)
      const run = (inFlight ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => publishNow(indexName, configurationOf))
      const tracked = run.finally(() => {
        if (publishing.get(indexName) === tracked) publishing.delete(indexName)
      })
      publishing.set(indexName, tracked)
      return tracked
    },

    published,

    pin: snapshot => pins.pin(snapshot.keys),

    async readFileRange(key, offset, length) {
      const readRange = directory.readRange
      if (readRange !== undefined) return readRange.call(directory, key, offset, length)
      const whole = await directory.read(key)
      return (whole ?? new Uint8Array(0)).subarray(offset, offset + length)
    },

    async release(indexName) {
      await deps.inCheckpointTurn(indexName, async () => {
        const previous = await published(indexName)
        await directory.remove(publishedSnapshotKey(indexName))
        cache.set(indexName, null)
        if (previous !== null) await removeUnlisted(indexName, previous.keys, new Set())
        await removeHistory(directory, indexName)
      })
    },

    removeHistory: (indexName, partitionId) => removeHistory(directory, indexName, partitionId),

    async enforceHistoryLimits(indexName, limits, publish, nowMs) {
      const current = await published(indexName)
      return enforceHistoryLimits({
        directory,
        indexName,
        limits,
        nowMs,
        publish,
        publishedLastSeqNo: partitionId =>
          cache.get(indexName)?.manifest.checkpoint.find(entry => entry.partitionId === partitionId)?.lastSeqNo ??
          (current === null ? null : 0),
      })
    },

    openPartitionLog: (indexName, partitionId) => openPartitionLog(directory, indexName, partitionId),

    readPartitionLog: (indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes) =>
      readPartitionLog(directory, indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes),

    logBytesAfter: (log, afterSeqNo) => logBytesAfter(directory, log, afterSeqNo),

    currentManifest: indexName => readCurrentManifest(store, indexName),

    async keepsCheckpointKey(indexName) {
      const current = await published(indexName)
      return key => pins.isPinned(key) || (current?.keys.has(key) ?? false)
    },

    async settleAtRecovery(indexName, active) {
      cache.delete(indexName)
      const publishedKey = publishedSnapshotKey(indexName)
      for (const key of await directory.list(syncDirectoryPrefix(indexName))) {
        if (key !== publishedKey) await directory.remove(key)
      }
      if (!active) {
        await directory.remove(publishedSnapshotKey(indexName))
        await removeHistory(directory, indexName)
        cache.set(indexName, null)
        return new Set()
      }
      try {
        return (await published(indexName))?.keys ?? new Set()
      } catch {
        await directory.remove(publishedSnapshotKey(indexName))
        cache.set(indexName, null)
        return new Set()
      }
    },

    forget(indexName) {
      cache.delete(indexName)
    },
  }
}
