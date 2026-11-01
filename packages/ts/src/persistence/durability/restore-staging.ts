import { ErrorCodes, NarsilError } from '../../errors'
import type { PersistenceAdapter } from '../../types/adapters'
import type { DurableDirectory } from './durable-filesystem'
import {
  commitJournal,
  finishJournal,
  journalKey,
  newStagingPrefix,
  type RestoreStorage,
  removePrefix,
} from './restore-journal'
import { adapterCheckpointStore, type CheckpointStore } from './segment/store'

export interface RestoreStaging {
  readonly store: CheckpointStore
  relocation(): Promise<((path: string) => string) | null>
  commit(): Promise<void>
  finish(): Promise<void>
  removeRetired(): Promise<void>
  discard(): Promise<void>
}

export interface RestoreStagingOptions {
  finish?(run: () => Promise<void>): Promise<void>
  onStorageLost?(error: Error): void
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function pathUnder(path: string, root: string): boolean {
  if (!path.startsWith(root)) return false
  const next = path.charAt(root.length)
  return next === '' || next === '/' || next === '\\'
}

function stagedDirectory(
  directory: DurableDirectory,
  staged: (key: string) => string,
  unstaged: (key: string) => string,
): DurableDirectory {
  const { readRange, byteLength } = directory
  return {
    root: directory.root,
    appendHandle: key => directory.appendHandle(staged(key)),
    markerHandle: key => directory.markerHandle(staged(key)),
    atomicWrite: (key, data) => directory.atomicWrite(staged(key), data),
    syncDirectoryOf: key => directory.syncDirectoryOf(staged(key)),
    read: key => directory.read(staged(key)),
    remove: key => directory.remove(staged(key)),
    move: (from, to) => directory.move(staged(from), staged(to)),
    list: async prefix => (await directory.list(staged(prefix))).map(unstaged),
    pathOf: key => directory.pathOf(staged(key)),
    ...(readRange === undefined
      ? {}
      : {
          readRange: (key: string, offset: number, length: number) =>
            readRange.call(directory, staged(key), offset, length),
        }),
    ...(byteLength === undefined ? {} : { byteLength: (key: string) => byteLength.call(directory, staged(key)) }),
  }
}

export function createRestoreStaging(
  storage: RestoreStorage,
  indexName: string,
  options: RestoreStagingOptions = {},
): RestoreStaging {
  const stagingPrefix = newStagingPrefix()
  const indexRoot = `${indexName}/`
  let committed = false
  const staged = (key: string): string => {
    if (!key.startsWith(indexRoot)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `A restore of "${indexName}" cannot stage "${key}"`, {
        key,
      })
    }
    return `${stagingPrefix}${key.slice(indexRoot.length)}`
  }
  const unstaged = (key: string): string => `${indexRoot}${key.slice(stagingPrefix.length)}`
  const store: CheckpointStore = {
    read: key => storage.read(staged(key)),
    write: (key, chunks) => storage.write(staged(key), chunks),
    remove: key => storage.remove(staged(key)),
    list: async prefix => (await storage.list(staged(prefix))).map(unstaged),
  }
  const pathOf = storage.pathOf
  if (pathOf !== undefined) store.pathOf = key => pathOf.call(storage, staged(key))
  if (storage.directory !== undefined) store.directory = stagedDirectory(storage.directory, staged, unstaged)

  let retiredPrefix: string | null = null

  async function finishOnStorage(): Promise<void> {
    retiredPrefix = await finishJournal(storage, indexName, stagingPrefix)
  }

  return {
    store,
    async relocation(): Promise<((path: string) => string) | null> {
      if (pathOf === undefined || (await storage.list(stagingPrefix)).length > 0) return null
      const from = await pathOf.call(storage, stagingPrefix.slice(0, -1))
      const to = await pathOf.call(storage, indexName)
      return path => (pathUnder(path, from) ? `${to}${path.slice(from.length)}` : path)
    },
    async commit(): Promise<void> {
      try {
        await commitJournal(storage, indexName, stagingPrefix)
      } catch (error) {
        try {
          await storage.remove(journalKey(indexName))
        } catch (removal) {
          committed = true
          options.onStorageLost?.(toError(removal))
        }
        throw error
      }
      committed = true
    },
    async finish(): Promise<void> {
      try {
        await (options.finish === undefined ? finishOnStorage() : options.finish(finishOnStorage))
      } catch (error) {
        options.onStorageLost?.(toError(error))
      }
    },
    async removeRetired(): Promise<void> {
      const prefix = retiredPrefix
      retiredPrefix = null
      if (prefix !== null) await removePrefix(storage, prefix)
    },
    async discard(): Promise<void> {
      if (committed) return
      await removePrefix(storage, stagingPrefix)
    },
  }
}

export function adapterRestoreStorage(adapter: PersistenceAdapter): RestoreStorage {
  const store = adapterCheckpointStore(adapter)
  return {
    read: key => store.read(key),
    write: (key, chunks) => store.write(key, chunks),
    writeJournal: (key, bytes) => store.write(key, [bytes]),
    remove: key => store.remove(key),
    list: prefix => store.list(prefix),
    async moveKey(from: string, to: string): Promise<void> {
      const bytes = await store.read(from)
      if (bytes === null) return
      await store.write(to, [bytes])
      await store.remove(from)
    },
  }
}
