import { getFs } from '#platform/durable-fs'
import { type ErrorCode, ErrorCodes, NarsilError } from '../../errors'
import type { DurableDirectory } from './durable-filesystem'
import { type RestoreStorage, recoverRestoreJournals } from './restore-journal'

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function storageFailed(code: ErrorCode, message: string, key: string, error: unknown): NarsilError {
  return new NarsilError(code, message, { key, cause: error instanceof Error ? error.message : String(error) })
}

export function directoryRestoreStorage(directory: DurableDirectory): RestoreStorage {
  return {
    directory,
    read: key => directory.read(key),
    write: (key, chunks) => directory.atomicWrite(key, chunks),
    writeJournal: (key, bytes) => directory.atomicWrite(key, bytes),
    remove: key => directory.remove(key),
    list: prefix => directory.list(prefix),
    moveKey: (from, to) => directory.move(from, to),
    pathOf: key => directory.pathOf(key),
    async moveTree(from: string, to: string): Promise<void> {
      const source = await directory.pathOf(from)
      const target = await directory.pathOf(to)
      const fs = await getFs()
      try {
        await fs.rename(source, target)
      } catch (error) {
        if (missing(error)) return
        throw storageFailed(ErrorCodes.PERSISTENCE_SAVE_FAILED, `Failed to move "${from}" to "${to}"`, from, error)
      }
      await directory.syncDirectoryOf(to)
    },
    async removeTree(prefix: string): Promise<void> {
      const key = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      const fs = await getFs()
      try {
        await fs.rm(await directory.pathOf(key), { recursive: true, force: true })
      } catch (error) {
        throw storageFailed(ErrorCodes.PERSISTENCE_DELETE_FAILED, `Failed to delete "${key}"`, key, error)
      }
      await directory.syncDirectoryOf(key)
    },
  }
}

export function recoverDirectoryRestores(directory: DurableDirectory): Promise<void> {
  return recoverRestoreJournals(directoryRestoreStorage(directory))
}
