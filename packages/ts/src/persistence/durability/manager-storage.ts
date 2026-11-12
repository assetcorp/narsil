import type { IndexStoredSizes } from '../../engine/stored-sizes'
import type { PartitionStatsResult } from '../../types/results'
import { type ArchiveCheckpointAccess, createArchiveCheckpointAccess } from './archive-checkpoint'
import { checkpointInTurn } from './checkpoint-turn'
import type { DurableDirectory } from './durable-filesystem'
import type { StoredSizesRecord } from './index-stored-sizes'
import type { LogBytesLedger } from './log-bytes'
import type { IndexState } from './manager-state'
import { createIndexUnloading, type IndexUnloading } from './manager-unload'
import type { MetadataWriteQueue } from './metadata-write-queue'
import type { RecoverPersistedIndexDeps } from './recover-index'
import { readSegmentManifest } from './segment/load'
import { directoryCheckpointStore } from './segment/store'
import { NOTHING_SAVED, type StoredBytes, savedBytesOfManifest } from './stored-bytes'
import { createSyncStorage, type SyncStorage } from './sync/storage'
import type { IndexDurabilityHooks } from './types'
import { releaseStalledWrites } from './write-stall'

export interface IndexStorageAccessDeps {
  directory: DurableDirectory
  logBytes: LogBytesLedger
  sizes: StoredSizesRecord
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
  storedSizesOf(indexName: string): IndexStoredSizes
  addStoredSizes(indexName: string, stats: PartitionStatsResult[]): void
  vectorSavedBytes(indexName: string): number | undefined
  measureRestoredStorage(indexName: string, restored?: StoredBytes): Promise<void>
}

export interface IndexStorageAccess {
  archiveAccess: ArchiveCheckpointAccess
  syncStorage: SyncStorage
  unloading: IndexUnloading
  storedBytesAccess: StoredBytesAccess
  recoveryDeps: RecoverPersistedIndexDeps
}

export function createIndexStorageAccess(deps: IndexStorageAccessDeps): IndexStorageAccess {
  const { directory, logBytes, sizes } = deps
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
      const indexState = deps.indexes.get(indexName)
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
    indexes: deps.indexes,
    metadataWrites: deps.metadataWrites,
    closeWriterReportingFailure: deps.closeWriterReportingFailure,
    forgetSyncState: syncStorage.forget,
    forgetStoredBytes: indexName => {
      sizes.forget(indexName)
      logBytes.forget(indexName)
    },
    dropStoredBytes: indexName => {
      sizes.drop(indexName)
      logBytes.forget(indexName)
    },
  })
  async function measureStoredBytes(indexName: string, saved: StoredBytes): Promise<void> {
    sizes.setSaved(indexName, saved)
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
  const storedBytesAccess: StoredBytesAccess = {
    storedSizesOf: sizes.of,
    addStoredSizes(indexName, stats) {
      sizes.of(indexName).addTo(stats)
    },
    vectorSavedBytes(indexName) {
      return sizes.of(indexName).vectorSavedBytes
    },
    async measureRestoredStorage(indexName, restored) {
      if (restored !== undefined) {
        await measureStoredBytes(indexName, restored)
        return
      }
      const decoded = await readSegmentManifest(directoryCheckpointStore(directory), indexName)
      await measureStoredBytes(
        indexName,
        decoded?.kind === 'current' ? savedBytesOfManifest(decoded.manifest) : NOTHING_SAVED,
      )
    },
  }
  return { archiveAccess, syncStorage, unloading, storedBytesAccess, recoveryDeps }
}
