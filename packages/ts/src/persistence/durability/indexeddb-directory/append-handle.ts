import { ErrorCodes, NarsilError } from '#platform/storage-host'
import { INDEXEDDB_BLOCK_BYTES } from '../constants'
import type { AppendHandle } from '../durable-filesystem'
import type { BlockLength, BlockMap } from './block-map'
import { type CommitDurability, type LogConnection, requestResult, type StoreFailure } from './connection'
import { type AppendedRecord, appendKey, lengthsOf, readRecords, splitIntoBlocks } from './records'

export interface OpenFile {
  key: string
  parts: BlockLength[]
  unsynced: AppendedRecord[]
  nextN: number
  handles: number
  detached: boolean
  failure: Error | null
  moving: Promise<void> | null
}

export interface AppendHandleDeps {
  connection: LogConnection
  blocks: BlockMap
  relaxedAppends: boolean
  release(file: OpenFile): void
}

export async function openFileRecords(connection: LogConnection, key: string): Promise<OpenFile> {
  const parts = await connection.write(
    'strict',
    { code: ErrorCodes.PERSISTENCE_SAVE_FAILED, action: 'open a log file' },
    async store => {
      const records = await readRecords(store, key)
      if (records !== null) return lengthsOf(records)
      await requestResult(store.put(new Uint8Array(0), key))
      return [{ n: 0, length: 0 }]
    },
  )
  const nextN = parts[parts.length - 1].n + 1
  return { key, parts, unsynced: [], nextN, handles: 0, detached: false, failure: null, moving: null }
}

async function waitForMove(file: OpenFile): Promise<void> {
  while (file.moving !== null) await file.moving
}

function lengthsOfRecords(records: readonly AppendedRecord[]): BlockLength[] {
  return records.map(record => ({ n: record.n, length: record.bytes.byteLength }))
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
  const { connection, blocks } = deps
  const appendFailure = { code: ErrorCodes.PERSISTENCE_SAVE_FAILED, action: 'append to a log file' }
  const strictCommitFailure: StoreFailure = {
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

  async function putCommitted(
    durability: CommitDurability,
    failure: StoreFailure,
    records: readonly AppendedRecord[],
  ): Promise<void> {
    const key = file.key
    const epoch = blocks.appendEpochOf(key)
    try {
      await connection.write(durability, failure, store => putRecords(store, key, records))
    } catch (error) {
      throw latch(error)
    }
    blocks.appended(key, epoch, lengthsOfRecords(records))
  }

  async function writeUnsynced(durability: CommitDurability): Promise<void> {
    if (file.moving !== null) await waitForMove(file)
    const batch = file.unsynced.slice()
    if (batch.length === 0) return
    await putCommitted(durability, durability === 'strict' ? strictCommitFailure : appendFailure, batch)
    file.unsynced.splice(0, batch.length)
  }

  async function truncateTo(byteLength: number): Promise<void> {
    if (file.moving !== null) await waitForMove(file)
    const key = file.key
    const batch = file.unsynced.slice()
    const kept: BlockLength[] = []
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
    const epoch = blocks.begin(key)
    try {
      await connection.write('strict', strictCommitFailure, async store => {
        await putRecords(store, key, batch)
        for (const part of dropped) await requestResult(store.delete(recordKeyOf(key, part.n)))
        if (!cutIsPartial) return
        const recordKey = recordKeyOf(key, cut.n)
        const stored = await requestResult(store.get(recordKey))
        if (!(stored instanceof Uint8Array) || stored.byteLength < cutLength) {
          throw new NarsilError(
            ErrorCodes.PERSISTENCE_LOAD_FAILED,
            `A record of "${key}" holds fewer bytes than its log`,
            {
              key,
            },
          )
        }
        await requestResult(store.put(stored.slice(0, cutLength), recordKey))
      })
    } catch (error) {
      blocks.settle(key, epoch, undefined)
      throw error
    }
    blocks.settle(key, epoch, kept)
    file.parts = kept
    file.unsynced = []
    file.nextN = kept[kept.length - 1].n + 1
  }

  return {
    async append(bytes: Uint8Array): Promise<void> {
      requireUsable()
      if (bytes.byteLength === 0) return
      const records: AppendedRecord[] = []
      for (const piece of splitIntoBlocks([bytes], INDEXEDDB_BLOCK_BYTES)) {
        if (holdsNoBytes(file)) {
          file.parts[0] = { n: 0, length: piece.byteLength }
          records.push({ n: 0, bytes: piece })
          continue
        }
        records.push({ n: file.nextN, bytes: piece })
        file.parts.push({ n: file.nextN, length: piece.byteLength })
        file.nextN += 1
      }
      file.unsynced.push(...records)
      if (!deps.relaxedAppends) return
      if (file.moving !== null) await waitForMove(file)
      await putCommitted('relaxed', appendFailure, records)
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
