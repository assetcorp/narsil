import { ErrorCodes, NarsilError } from '../../errors'
import type { DurableDirectory } from './durable-filesystem'
import type { PartitionCheckpoint } from './partition-checkpoint'
import { manifestKey } from './segment/layout'
import type { FileRef, SegmentManifest } from './segment/manifest'
import { decodeSegmentManifest } from './segment/manifest-decode'
import { type CheckpointStore, directoryCheckpointStore, readListedFile } from './segment/store'

export interface ArchiveCheckpoint {
  manifestBytes: Uint8Array
  manifest: SegmentManifest
  readFile(ref: FileRef): Promise<Uint8Array>
  readRange(ref: FileRef, offset: number, length: number): Promise<Uint8Array>
  release(): void
}

export interface RestoreStaging {
  readonly store: CheckpointStore
  commit(): Promise<CheckpointStore>
  discard(): Promise<void>
}

export interface ArchiveCheckpointAccess {
  openArchiveCheckpoint(indexName: string): Promise<ArchiveCheckpoint>
  stageRestore(indexName: string): RestoreStaging
  adoptRestoredCheckpoint(indexName: string, checkpoint: readonly PartitionCheckpoint[]): void
}

export const RESTORE_STAGING_PREFIX = '.restore-'

function createRestoreStaging(
  directory: DurableDirectory,
  indexStore: CheckpointStore,
  indexName: string,
): RestoreStaging {
  const stagingRoot = `${RESTORE_STAGING_PREFIX}${indexName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}/`
  const indexRoot = `${indexName}/`
  const staged = (key: string): string => {
    if (!key.startsWith(indexRoot)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `A restore of "${indexName}" cannot stage "${key}"`, {
        key,
      })
    }
    return `${stagingRoot}${key.slice(indexRoot.length)}`
  }
  const unstaged = (key: string): string => `${indexRoot}${key.slice(stagingRoot.length)}`
  const stagingStore: CheckpointStore = {
    read: key => directory.read(staged(key)),
    write: (key, chunks) => directory.atomicWrite(staged(key), chunks),
    remove: key => directory.remove(staged(key)),
    list: async prefix => (await directory.list(staged(prefix))).map(unstaged),
    pathOf: key => directory.pathOf(staged(key)),
  }
  return {
    store: stagingStore,
    async commit(): Promise<CheckpointStore> {
      for (const key of await directory.list(stagingRoot)) await directory.move(key, unstaged(key))
      return indexStore
    },
    async discard(): Promise<void> {
      for (const key of await directory.list(stagingRoot)) await directory.remove(key)
    },
  }
}

export async function removeAbandonedRestores(directory: DurableDirectory): Promise<void> {
  for (const key of await directory.list(RESTORE_STAGING_PREFIX)) await directory.remove(key)
}

export interface ArchiveCheckpointDeps {
  directory: DurableDirectory
  held: Map<string, number>
  checkpoint(indexName: string): Promise<void>
  registerPartition(indexName: string, partitionId: number, startSeqNo: number): void
}

function releaser(held: Map<string, number>, indexName: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (held.get(indexName) ?? 1) - 1
    if (count <= 0) held.delete(indexName)
    else held.set(indexName, count)
  }
}

export function createArchiveCheckpointAccess(deps: ArchiveCheckpointDeps): ArchiveCheckpointAccess {
  const store = directoryCheckpointStore(deps.directory)
  return {
    async openArchiveCheckpoint(indexName: string): Promise<ArchiveCheckpoint> {
      deps.held.set(indexName, (deps.held.get(indexName) ?? 0) + 1)
      const release = releaser(deps.held, indexName)
      try {
        await deps.checkpoint(indexName)
        await deps.checkpoint(indexName)
        const manifestBytes = await deps.directory.read(manifestKey(indexName))
        if (manifestBytes === null) {
          throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `Index "${indexName}" holds no checkpoint`, {
            indexName,
          })
        }
        const decoded = await decodeSegmentManifest(manifestBytes, indexName)
        if (decoded.kind !== 'current') {
          throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `Index "${indexName}" holds an earlier layout`, {
            indexName,
          })
        }
        return {
          manifestBytes,
          manifest: decoded.manifest,
          readFile: ref => readListedFile(store, ref.key, { bytes: ref.bytes, what: 'checkpoint file' }),
          readRange: async (ref, offset, length) => {
            const readRange = deps.directory.readRange
            if (readRange !== undefined) return readRange.call(deps.directory, ref.key, offset, length)
            const whole = await readListedFile(store, ref.key, { bytes: ref.bytes, what: 'checkpoint file' })
            return whole.slice(offset, offset + length)
          },
          release,
        }
      } catch (error) {
        release()
        throw error
      }
    },

    stageRestore(indexName: string): RestoreStaging {
      return createRestoreStaging(deps.directory, store, indexName)
    },

    adoptRestoredCheckpoint(indexName: string, checkpoint: readonly PartitionCheckpoint[]): void {
      for (const { partitionId, lastSeqNo } of checkpoint) deps.registerPartition(indexName, partitionId, lastSeqNo)
    },
  }
}
