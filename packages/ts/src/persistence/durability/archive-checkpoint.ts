import { ErrorCodes, NarsilError } from '../../errors'
import type { DurableDirectory } from './durable-filesystem'
import type { PartitionCheckpoint } from './partition-checkpoint'
import { directoryRestoreStorage } from './restore-directory'
import { createRestoreStaging, type RestoreStaging } from './restore-staging'
import { manifestKey } from './segment/layout'
import type { FileRef, SegmentManifest } from './segment/manifest'
import { decodeSegmentManifest } from './segment/manifest-decode'
import { directoryCheckpointStore, readListedFile } from './segment/store'

export interface ArchiveCheckpoint {
  manifestBytes: Uint8Array
  manifest: SegmentManifest
  readFile(ref: FileRef): Promise<Uint8Array>
  readRange(ref: FileRef, offset: number, length: number): Promise<Uint8Array>
  release(): void
}

export interface ArchiveCheckpointAccess {
  openArchiveCheckpoint(indexName: string): Promise<ArchiveCheckpoint>
  stageRestore(indexName: string): RestoreStaging
  adoptRestoredCheckpoint(indexName: string, checkpoint: readonly PartitionCheckpoint[]): void
}

export interface ArchiveCheckpointDeps {
  directory: DurableDirectory
  held: Map<string, number>
  checkpoint(indexName: string): Promise<void>
  registerPartition(indexName: string, partitionId: number, startSeqNo: number, primaryTerm: number): void
  markFatal(error: Error): void
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function stageDirectoryRestore(deps: ArchiveCheckpointDeps, indexName: string): RestoreStaging {
  return createRestoreStaging(directoryRestoreStorage(deps.directory), indexName, {
    async finish(run) {
      try {
        await run()
      } catch (error) {
        deps.markFatal(toError(error))
        throw error
      }
    },
    onStorageLost: deps.markFatal,
  })
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
      return stageDirectoryRestore(deps, indexName)
    },

    adoptRestoredCheckpoint(indexName: string, checkpoint: readonly PartitionCheckpoint[]): void {
      for (const { partitionId, lastSeqNo, primaryTerm } of checkpoint) {
        deps.registerPartition(indexName, partitionId, lastSeqNo, primaryTerm)
      }
    },
  }
}
