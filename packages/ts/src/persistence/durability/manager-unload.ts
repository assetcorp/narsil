import type { DurableDirectory } from './durable-filesystem'
import { drainIndexStateForUnload, type IndexState } from './manager-state'
import type { MetadataWriteQueue } from './metadata-write-queue'
import { removeQueryHistoryOf } from './query-history'
import type { IndexDurabilityHooks } from './types'

export interface IndexUnloadDeps {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  indexes: Map<string, IndexState>
  metadataWrites: MetadataWriteQueue
  closeWriterReportingFailure(close: Promise<void>): Promise<void>
  forgetSyncState(indexName: string): void
  forgetStoredBytes(indexName: string): void
}

export interface IndexUnloading {
  removeIndex(indexName: string): Promise<void>
  unloadIndex(indexName: string): Promise<void>
}

export function createIndexUnloading(deps: IndexUnloadDeps): IndexUnloading {
  const { directory, hooks, indexes, metadataWrites } = deps
  return {
    async removeIndex(indexName: string): Promise<void> {
      hooks.writeRecords?.dropIndex(indexName)
      const indexState = indexes.get(indexName)
      if (indexState !== undefined) {
        await drainIndexStateForUnload(indexState, metadataWrites.pending(indexName), deps.closeWriterReportingFailure)
        indexes.delete(indexName)
        metadataWrites.forget(indexName)
      }
      for (const vectorIndex of hooks.getVectorIndexes(indexName).values()) await vectorIndex.releaseVectorFiles()
      for (const key of await directory.list(`${indexName}/`)) {
        await directory.remove(key)
      }
      await removeQueryHistoryOf({ kind: 'directory', directory }, indexName)
      deps.forgetSyncState(indexName)
      deps.forgetStoredBytes(indexName)
    },

    async unloadIndex(indexName: string): Promise<void> {
      const indexState = indexes.get(indexName)
      if (indexState === undefined) {
        return
      }
      await drainIndexStateForUnload(indexState, metadataWrites.pending(indexName), close => close)
      indexes.delete(indexName)
      metadataWrites.forget(indexName)
      deps.forgetSyncState(indexName)
      deps.forgetStoredBytes(indexName)
    },
  }
}
