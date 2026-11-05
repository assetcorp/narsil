import { type ArchiveCheckpointAccess, createArchiveCheckpointAccess } from './archive-checkpoint'
import { checkpointInTurn } from './checkpoint-turn'
import type { DurableDirectory } from './durable-filesystem'
import type { IndexState } from './manager-state'
import { createIndexUnloading, type IndexUnloading } from './manager-unload'
import type { MetadataWriteQueue } from './metadata-write-queue'
import { createSyncStorage, type SyncStorage } from './sync/storage'
import type { IndexDurabilityHooks } from './types'
import { releaseStalledWrites } from './write-stall'

export interface IndexStorageAccessDeps {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  indexes: Map<string, IndexState>
  metadataWrites: MetadataWriteQueue
  heldCheckpointFiles: Map<string, number>
  checkpoint(indexName: string, pinsVectors: boolean): Promise<void>
  registerPartition(indexName: string, partitionId: number, startSeqNo: number, primaryTerm: number): void
  markFatal(error: Error): void
  closeWriterReportingFailure(close: Promise<void>): Promise<void>
}

export interface IndexStorageAccess {
  archiveAccess: ArchiveCheckpointAccess
  syncStorage: SyncStorage
  unloading: IndexUnloading
}

export function createIndexStorageAccess(deps: IndexStorageAccessDeps): IndexStorageAccess {
  const { directory, indexes } = deps
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
  })
  return { archiveAccess, syncStorage, unloading }
}
