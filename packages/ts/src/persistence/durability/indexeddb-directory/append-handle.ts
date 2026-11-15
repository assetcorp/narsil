import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { AppendHandle } from '../durable-filesystem'
import { type CommitDurability, type LogConnection, requestResult } from './connection'
import { type AppendedRecord, appendKey, compactBytes, readRecords } from './records'

interface StoredPart {
  n: number
  length: number
}

export interface OpenFile {
  key: string
  parts: StoredPart[]
  unsynced: AppendedRecord[]
  nextN: number
  handles: number
  detached: boolean
  failure: Error | null
}

export interface AppendHandleDeps {
  connection: LogConnection
  relaxedAppends: boolean
  release(file: OpenFile): void
}

export async function openFileRecords(connection: LogConnection, key: string): Promise<OpenFile> {
  const parts = await connection.write(
    'strict',
    { code: ErrorCodes.PERSISTENCE_SAVE_FAILED, action: 'open a log file' },
    async store => {
      const records = await readRecords(store, key)
      if (records === null) {
        await requestResult(store.put(new Uint8Array(0), key))
        return [{ n: 0, length: 0 }]
      }
      return [
        { n: 0, length: records.first.byteLength },
        ...records.appended.map(record => ({ n: record.n, length: record.bytes.byteLength })),
      ]
    },
  )
  return { key, parts, unsynced: [], nextN: parts[parts.length - 1].n + 1, handles: 0, detached: false, failure: null }
}

function sizeOf(file: OpenFile): number {
  let size = 0
  for (const part of file.parts) size += part.length
  return size
}

function recordKeyOf(key: string, n: number): IDBValidKey {
  return n === 0 ? key : appendKey(key, n)
}

function putRecords(store: IDBObjectStore, key: string, records: readonly AppendedRecord[]): Promise<unknown[]> {
  return Promise.all(records.map(record => requestResult(store.put(record.bytes, recordKeyOf(key, record.n)))))
}

function holdsNoBytes(file: OpenFile): boolean {
  return file.parts.length === 1 && file.parts[0].length === 0
}

export function createAppendHandle(file: OpenFile, deps: AppendHandleDeps): AppendHandle {
  const { connection } = deps
  const appendFailure = { code: ErrorCodes.PERSISTENCE_SAVE_FAILED, action: 'append to a log file' }
  const strictCommitFailure = {
    code: ErrorCodes.PERSISTENCE_FSYNC_FAILED,
    action: 'commit a log file with strict durability',
  }
  let closed = false
  file.handles += 1

  function requireUsable(): void {
    if (closed) throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `The log file "${file.key}" is closed`)
    if (file.failure !== null) throw file.failure
    if (file.detached) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `The log file "${file.key}" was removed or replaced while a handle held it open`,
        { key: file.key },
      )
    }
  }

  function latch(error: unknown): Error {
    const failed = error instanceof Error ? error : new Error(String(error))
    file.failure ??= failed
    return file.failure
  }

  async function writeUnsynced(durability: CommitDurability): Promise<void> {
    const batch = file.unsynced.slice()
    if (batch.length === 0) return
    try {
      await connection.write(durability, durability === 'strict' ? strictCommitFailure : appendFailure, store =>
        putRecords(store, file.key, batch),
      )
    } catch (error) {
      throw latch(error)
    }
    file.unsynced.splice(0, batch.length)
  }

  async function truncateTo(byteLength: number): Promise<void> {
    const batch = file.unsynced.slice()
    const kept: StoredPart[] = []
    let start = 0
    for (const part of file.parts) {
      if (start >= byteLength && part.n !== 0) break
      kept.push({ ...part, length: Math.min(part.length, byteLength - start) })
      start += part.length
    }
    const dropped = file.parts.slice(kept.length)
    const cut = kept[kept.length - 1]
    const cutLength = cut.length
    const cutIsPartial = cutLength < (file.parts[kept.length - 1]?.length ?? 0)
    await connection.write('strict', strictCommitFailure, async store => {
      await putRecords(store, file.key, batch)
      for (const part of dropped) await requestResult(store.delete(recordKeyOf(file.key, part.n)))
      if (!cutIsPartial) return
      const recordKey = recordKeyOf(file.key, cut.n)
      const stored = await requestResult(store.get(recordKey))
      if (!(stored instanceof Uint8Array) || stored.byteLength < cutLength) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_LOAD_FAILED,
          `A record of "${file.key}" holds fewer bytes than its log`,
          {
            key: file.key,
          },
        )
      }
      await requestResult(store.put(stored.slice(0, cutLength), recordKey))
    })
    file.parts = kept
    file.unsynced = []
    file.nextN = kept[kept.length - 1].n + 1
  }

  return {
    async append(bytes: Uint8Array): Promise<void> {
      requireUsable()
      if (bytes.byteLength === 0) return
      const owned = compactBytes(bytes)
      const record: AppendedRecord = holdsNoBytes(file) ? { n: 0, bytes: owned } : { n: file.nextN, bytes: owned }
      if (record.n === 0) {
        file.parts[0] = { n: 0, length: owned.byteLength }
      } else {
        file.nextN += 1
        file.parts.push({ n: record.n, length: owned.byteLength })
      }
      file.unsynced.push(record)
      if (!deps.relaxedAppends) return
      try {
        await connection.write('relaxed', appendFailure, store => putRecords(store, file.key, [record]))
      } catch (error) {
        throw latch(error)
      }
    },

    async sync(): Promise<void> {
      requireUsable()
      await writeUnsynced('strict')
    },

    async truncate(byteLength: number): Promise<void> {
      requireUsable()
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > sizeOf(file)) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_SAVE_FAILED,
          `The log file "${file.key}" cannot be cut to ${byteLength} bytes, because it holds ${sizeOf(file)}`,
          { key: file.key, byteLength },
        )
      }
      try {
        await truncateTo(byteLength)
      } catch (error) {
        throw latch(error)
      }
    },

    async size(): Promise<number> {
      if (closed) throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `The log file "${file.key}" is closed`)
      return sizeOf(file)
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      file.handles -= 1
      try {
        if (!deps.relaxedAppends && file.failure === null && !file.detached) await writeUnsynced('relaxed')
      } finally {
        if (file.handles === 0) deps.release(file)
      }
    },
  }
}
