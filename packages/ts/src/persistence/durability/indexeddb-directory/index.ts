import { compareCodePoints, ErrorCodes, NarsilError } from '#platform/storage-host'
import type { IndexedDBLocation } from '../../../types/adapters'
import { INDEXEDDB_BLOCK_BYTES } from '../constants'
import type { AppendHandle, DurableDirectory, MarkerHandle } from '../durable-filesystem'
import { createAppendHandle, type OpenFile, openFileRecords } from './append-handle'
import { type BlockLength, createBlockMap, laidOut } from './block-map'
import { openLogConnection, requestResult } from './connection'
import { lockIndexedDBStore } from './lock'
import { createRangeReads } from './range-read'
import {
  contentOf,
  type FileRecords,
  lengthsOf,
  listKeys,
  readRecords,
  removeRecords,
  replaceRecords,
  splitIntoBlocks,
} from './records'

export interface IndexedDBDirectoryOptions {
  relaxedAppends: boolean
}

function noValue(): undefined {
  return undefined
}

function requireKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Invalid key: empty')
  }
  if (key.includes('\0')) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Invalid key: null byte detected', { key })
  }
}

export function createIndexedDBDirectory(
  location: IndexedDBLocation,
  options: IndexedDBDirectoryOptions,
): DurableDirectory {
  const saveFailed = ErrorCodes.PERSISTENCE_SAVE_FAILED
  const loadFailed = ErrorCodes.PERSISTENCE_LOAD_FAILED
  const connection = openLogConnection(location)
  const blocks = createBlockMap()
  const openFiles = new Map<string, OpenFile>()
  const opening = new Map<string, Promise<OpenFile>>()

  async function settledWrite<T>(
    key: string,
    write: () => Promise<T>,
    lengthsAfter: (result: T) => readonly BlockLength[] | undefined,
  ): Promise<T> {
    const epoch = blocks.begin(key)
    let result: T
    try {
      result = await write()
    } catch (error) {
      blocks.settle(key, epoch, undefined)
      throw error
    }
    blocks.settle(key, epoch, lengthsAfter(result))
    return result
  }

  function detach(key: string): void {
    const file = openFiles.get(key)
    if (file === undefined) return
    file.detached = true
    openFiles.delete(key)
  }

  function release(file: OpenFile): void {
    if (openFiles.get(file.key) === file) openFiles.delete(file.key)
  }

  async function openFile(key: string): Promise<OpenFile> {
    const existing = openFiles.get(key)
    if (existing !== undefined) return existing
    const pending = opening.get(key)
    if (pending !== undefined) return pending
    const opened = settledWrite(
      key,
      () => openFileRecords(connection, key),
      file => file.parts,
    ).then(
      file => {
        opening.delete(key)
        openFiles.set(key, file)
        return file
      },
      error => {
        opening.delete(key)
        throw error
      },
    )
    opening.set(key, opened)
    return opened
  }

  async function readContent(key: string): Promise<Uint8Array | null> {
    requireKey(key)
    const view = blocks.viewOf(key)
    const records = await connection.read({ code: loadFailed, action: `read "${key}"` }, store =>
      readRecords(store, key),
    )
    if (records === null) return null
    blocks.install(key, view, laidOut(lengthsOf(records)), true)
    return contentOf(records)
  }

  const ranges = createRangeReads(connection, blocks, readContent)

  function renameAfterMove(moving: OpenFile, from: string, to: string): void {
    moving.key = to
    if (openFiles.get(from) !== moving) return
    openFiles.delete(from)
    detach(to)
    openFiles.set(to, moving)
  }

  async function moveRecords(from: string, to: string): Promise<void> {
    const fromEpoch = blocks.begin(from)
    const moved = settledWrite(
      to,
      () =>
        connection.write('strict', { code: saveFailed, action: `move "${from}" to "${to}"` }, async store => {
          const records = await readRecords(store, from)
          if (records === null) {
            throw new NarsilError(saveFailed, `Failed to move "${from}" to "${to}": "${from}" holds nothing`, {
              from,
              to,
            })
          }
          await replaceRecords(store, to, records)
          await removeRecords(store, from)
          return lengthsOf(records)
        }),
      lengths => lengths,
    )
    const moving = openFiles.get(from)
    if (moving !== undefined) moving.moving = moved.then(noValue, noValue)
    try {
      await moved
      if (moving !== undefined) renameAfterMove(moving, from, to)
    } finally {
      blocks.settle(from, fromEpoch, undefined)
      if (moving !== undefined) moving.moving = null
    }
  }

  return {
    root: connection.root,

    async appendHandle(key: string): Promise<AppendHandle> {
      requireKey(key)
      const file = await openFile(key)
      return createAppendHandle(file, { connection, blocks, relaxedAppends: options.relaxedAppends, release })
    },

    async markerHandle(key: string): Promise<MarkerHandle> {
      requireKey(key)
      let current = await settledWrite(
        key,
        () =>
          connection.write('strict', { code: saveFailed, action: `open "${key}"` }, async store => {
            const records = await readRecords(store, key)
            if (records !== null) return contentOf(records)
            const empty = new Uint8Array(0)
            await requestResult(store.put(empty, key))
            return empty
          }),
        bytes => [{ n: 0, length: bytes.byteLength }],
      )
      return {
        read: async () => current.slice(),
        async writeSlot(offset: number, slot: Uint8Array): Promise<void> {
          const next = new Uint8Array(Math.max(current.byteLength, offset + slot.byteLength))
          next.set(current)
          next.set(slot, offset)
          await settledWrite(
            key,
            () =>
              connection.write(
                'strict',
                { code: ErrorCodes.PERSISTENCE_FSYNC_FAILED, action: `commit "${key}"` },
                store => replaceRecords(store, key, { first: next, appended: [] }),
              ),
            () => [{ n: 0, length: next.byteLength }],
          )
          current = next
        },
        close: async () => undefined,
      }
    },

    async atomicWrite(key: string, data: Uint8Array | readonly Uint8Array[]): Promise<void> {
      requireKey(key)
      const pieces = splitIntoBlocks(Array.isArray(data) ? data : [data as Uint8Array], INDEXEDDB_BLOCK_BYTES)
      const records: FileRecords = {
        first: pieces[0],
        appended: pieces.slice(1).map((bytes, at) => ({ n: at + 1, bytes })),
      }
      detach(key)
      await settledWrite(
        key,
        () =>
          connection.write('strict', { code: saveFailed, action: `write "${key}"` }, store =>
            replaceRecords(store, key, records),
          ),
        () => lengthsOf(records),
      )
    },

    async syncDirectoryOf(key: string): Promise<void> {
      requireKey(key)
    },

    read: readContent,

    async readRange(key: string, offset: number, length: number): Promise<Uint8Array> {
      requireKey(key)
      return ranges.readRange(key, offset, length)
    },

    async byteLength(key: string): Promise<number | null> {
      requireKey(key)
      return ranges.byteLength(key)
    },

    async remove(key: string): Promise<void> {
      requireKey(key)
      detach(key)
      await settledWrite(
        key,
        () =>
          connection.write('strict', { code: ErrorCodes.PERSISTENCE_DELETE_FAILED, action: `delete "${key}"` }, store =>
            removeRecords(store, key),
          ),
        () => undefined,
      )
    },

    async move(from: string, to: string): Promise<void> {
      requireKey(from)
      requireKey(to)
      if (from === to) return
      detach(to)
      await moveRecords(from, to)
    },

    async list(prefix: string): Promise<string[]> {
      const keys = await connection.read({ code: loadFailed, action: `list "${prefix}"` }, store =>
        listKeys(store, prefix),
      )
      return keys.sort(compareCodePoints)
    },

    identity: () => connection.identity(),

    async lock() {
      const held = await lockIndexedDBStore(location)
      return {
        holds: () => held.holds(),
        async release() {
          connection.close()
          await held.release()
        },
      }
    },
  }
}
