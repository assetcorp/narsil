import type { PartitionStatsResult } from '../../types/results'
import { type ArchiveCheckpointAccess, createArchiveCheckpointAccess } from './archive-checkpoint'
import { checkpointInTurn } from './checkpoint-turn'
import type { DurableDirectory } from './durable-filesystem'
import type { LogBytesLedger } from './log-bytes'
import type { IndexState } from './manager-state'
import { createIndexUnloading, type IndexUnloading } from './manager-unload'
import type { MetadataWriteQueue } from './metadata-write-queue'
import type { RecoverPersistedIndexDeps } from './recover-index'
import { readSegmentManifest } from './segment/load'
import { directoryCheckpointStore } from './segment/store'
import {
  createSavedBytesRecord,
  NOTHING_SAVED,
  partitionSavedBytes,
  type SavedBytesRecord,
  type StoredBytes,
  type StoredSize,
  savedBytesOfManifest,
} from './stored-bytes'
import { createSyncStorage, type SyncStorage } from './sync/storage'
import type { IndexDurabilityHooks } from './types'
import { releaseStalledWrites } from './write-stall'

export interface IndexStorageAccessDeps {
  directory: DurableDirectory
  logBytes: LogBytesLedger
  hooks: IndexDurabilityHooks
  indexes: Map<string, IndexState>
  metadataWrites: MetadataWriteQueue
  heldCheckpointFiles: Map<string, number>
  compactionThreshold: number
  checkpoint(indexName: string, pinsVectors: boolean): Promise<void>
  registerPartition(indexName: string, partitionId: number, startSeqNo: number, primaryTerm: number): void
  markFatal(error: Error): void
  closeWriterReportingFailure(close: Promise<void>): Promise<void>
}

export interface StoredBytesAccess {
  storedSize(indexName: string, recordedSavedBytes?: number): StoredSize
  withPartitionStoredSizes(indexName: string, stats: PartitionStatsResult[]): PartitionStatsResult[]
  vectorSavedBytes(indexName: string): number | undefined
  measureRestoredStorage(indexName: string): Promise<void>
}

export interface IndexStorageAccess {
  archiveAccess: ArchiveCheckpointAccess
  syncStorage: SyncStorage
  unloading: IndexUnloading
  savedBytes: SavedBytesRecord
  storedBytesAccess: StoredBytesAccess
  recoveryDeps: RecoverPersistedIndexDeps
}

export function createIndexStorageAccess(deps: IndexStorageAccessDeps): IndexStorageAccess {
  const { directory, indexes, logBytes } = deps
  const savedBytes = createSavedBytesRecord()
  const archiveAccess = createArchiveCheckpointAccess({
    directory,
    held: deps.heldCheckpointFiles,
    checkpoint: deps.checkpoint,
    registerPartition: deps.registerPartition,
    markFatal: deps.markFatal,
  })
  const syncStorage = createSyncStorage({
    directory,
    openArchiveCheckpoint: archiveAccess.openArchiveCheckpoint,
    inCheckpointTurn: (indexName, work) => {
      const indexState = indexes.get(indexName)
      if (indexState === undefined) return work()
      return checkpointInTurn(indexState, {
        joinsInFlight: false,
        mayStart: () => true,
        perform: work,
        afterSettling: () => releaseStalledWrites(indexState),
      })
    },
  })
  const unloading = createIndexUnloading({
    directory,
    hooks: deps.hooks,
    indexes,
    metadataWrites: deps.metadataWrites,
    closeWriterReportingFailure: deps.closeWriterReportingFailure,
    forgetSyncState: syncStorage.forget,
    forgetStoredBytes: indexName => {
      savedBytes.forget(indexName)
      logBytes.forget(indexName)
    },
  })
  async function measureStoredBytes(indexName: string, saved: StoredBytes): Promise<void> {
    savedBytes.record(indexName, saved)
    await logBytes.seed(indexName)
  }
  const recoveryDeps: RecoverPersistedIndexDeps = {
    directory,
    hooks: deps.hooks,
    compactionThreshold: deps.compactionThreshold,
    registerPartition: deps.registerPartition,
    holdsCheckpointFiles: indexName => deps.heldCheckpointFiles.has(indexName),
    queueMetadataWrite: deps.metadataWrites.queue,
    syncStorage,
    measureStoredBytes,
  }
  const sizeIsKnown = (indexName: string): boolean => savedBytes.of(indexName) !== undefined || indexes.has(indexName)
  const storedBytesAccess: StoredBytesAccess = {
    storedSize(indexName, recordedSavedBytes) {
      if (!sizeIsKnown(indexName)) return recordedSavedBytes === undefined ? {} : { savedBytes: recordedSavedBytes }
      return { savedBytes: savedBytes.of(indexName)?.bytes ?? 0, logBytes: logBytes.bytesOf(indexName) ?? 0 }
    },
    withPartitionStoredSizes(indexName, stats) {
      if (!sizeIsKnown(indexName)) return stats
      const saved = partitionSavedBytes(savedBytes.of(indexName))
      return stats.map(partition => ({
        ...partition,
        savedBytes: saved.get(partition.partitionId) ?? 0,
        logBytes: logBytes.partitionBytesOf(indexName, partition.partitionId),
      }))
    },
    vectorSavedBytes(indexName) {
      return sizeIsKnown(indexName) ? (savedBytes.of(indexName)?.vectorBytes ?? 0) : undefined
    },
    async measureRestoredStorage(indexName) {
      const decoded = await readSegmentManifest(directoryCheckpointStore(directory), indexName)
      await measureStoredBytes(
        indexName,
        decoded?.kind === 'current' ? savedBytesOfManifest(decoded.manifest) : NOTHING_SAVED,
      )
    },
  }
  return { archiveAccess, syncStorage, unloading, savedBytes, storedBytesAccess, recoveryDeps }
}
