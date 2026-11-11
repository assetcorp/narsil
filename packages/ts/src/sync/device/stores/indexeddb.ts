import { ErrorCodes, NarsilError } from '../../../errors'
import { loadMessagePack } from '../../../serialization/msgpack-code'
import { DEFAULT_INDEXEDDB_DEVICE_STORE_NAME } from '../constants'
import type { DeviceSyncStore, KeptEntry, QueuedWrite, SavedDownload } from '../types'
import {
  DOWNLOAD_STORE,
  inTransaction,
  KEPT_STORE,
  META_STORE,
  openDeviceDatabase,
  QUEUE_STORE,
  requestResult,
} from './indexeddb-requests'
import { decodeKeptEntries, decodePosition, downloadOutOfOrder, encodeKeptEntries, encodePosition } from './records'
import { createSerial } from './serial'

const POSITION_KEY = 'position'
const NEXT_SEQUENCE_KEY = 'nextSequence'
const NEXT_KEPT_KEY = 'nextKept'
const DOWNLOAD_KEY = 'download'

/**
 * The settings of {@link createIndexedDBDeviceStore}.
 *
 * @public
 */
export interface IndexedDBDeviceStoreConfig {
  /** The store keeps its records in the IndexedDB database with this name, `narsil-device-sync` by default. */
  databaseName?: string
}

interface SavedDownloadMeta {
  entityTag: string
  byteLength: number
}

function isDownloadMeta(value: unknown): value is SavedDownloadMeta {
  if (value === null || typeof value !== 'object') return false
  const meta = value as Record<string, unknown>
  return typeof meta.entityTag === 'string' && typeof meta.byteLength === 'number'
}

function countOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Opens a store that keeps a synced device's queue, kept feed entries, position, and snapshot download in IndexedDB,
 * for an app in a browser.
 *
 * The store commits every write in a strict-durability transaction before its promise resolves.
 *
 * @param config - The database to use. Omit it to accept the default name.
 * @returns The open store, which {@link DeviceSyncStore.close} releases.
 * @throws A `NarsilError` with `CONFIG_INVALID` in a runtime without IndexedDB.
 * @public
 */
export async function createIndexedDBDeviceStore(config?: IndexedDBDeviceStoreConfig): Promise<DeviceSyncStore> {
  await loadMessagePack()
  const database = await openDeviceDatabase(config?.databaseName ?? DEFAULT_INDEXEDDB_DEVICE_STORE_NAME)
  const serial = createSerial()
  let closed = false

  function guarded<T>(task: () => Promise<T>): Promise<T> {
    return serial.run(async () => {
      if (closed) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The device sync store is closed')
      return task()
    })
  }

  function readMeta(key: string): Promise<unknown> {
    return inTransaction(database, [META_STORE], 'readonly', transaction =>
      requestResult(transaction.objectStore(META_STORE).get(key)),
    )
  }

  async function readChunk(offset: number): Promise<Uint8Array> {
    const chunk = await inTransaction(database, [DOWNLOAD_STORE], 'readonly', transaction =>
      requestResult(transaction.objectStore(DOWNLOAD_STORE).get(offset)),
    )
    if (!(chunk instanceof Uint8Array)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'The device sync store lost part of a download')
    }
    return chunk
  }

  return {
    readPosition: () =>
      guarded(async () => {
        const saved = await readMeta(POSITION_KEY)
        return saved instanceof Uint8Array ? decodePosition(saved) : null
      }),

    writePosition: position =>
      guarded(() =>
        inTransaction(database, [META_STORE], 'readwrite', async transaction => {
          const meta = transaction.objectStore(META_STORE)
          if (position === null) {
            await requestResult(meta.delete(POSITION_KEY))
          } else {
            await requestResult(meta.put(encodePosition(position), POSITION_KEY))
          }
        }),
      ),

    appendWrite: write =>
      guarded(() =>
        inTransaction(database, [META_STORE, QUEUE_STORE], 'readwrite', async transaction => {
          const meta = transaction.objectStore(META_STORE)
          const sequence = countOf(await requestResult(meta.get(NEXT_SEQUENCE_KEY)), 1)
          const queued: QueuedWrite = { sequence, documentId: write.documentId, document: write.document }
          await requestResult(transaction.objectStore(QUEUE_STORE).put(queued, sequence))
          await requestResult(meta.put(sequence + 1, NEXT_SEQUENCE_KEY))
          return queued
        }),
      ),

    queuedWrites: () =>
      guarded(() =>
        inTransaction(database, [QUEUE_STORE], 'readonly', async transaction => {
          const values = await requestResult(transaction.objectStore(QUEUE_STORE).getAll())
          return (values as QueuedWrite[]).sort((a, b) => a.sequence - b.sequence)
        }),
      ),

    removeWrites: sequences =>
      guarded(() =>
        inTransaction(database, [QUEUE_STORE], 'readwrite', async transaction => {
          const queue = transaction.objectStore(QUEUE_STORE)
          await Promise.all(sequences.map(sequence => requestResult(queue.delete(sequence))))
        }),
      ),

    keepEntries: entries =>
      guarded(async () => {
        if (entries.length === 0) return
        await inTransaction(database, [META_STORE, KEPT_STORE], 'readwrite', async transaction => {
          const meta = transaction.objectStore(META_STORE)
          const batch = countOf(await requestResult(meta.get(NEXT_KEPT_KEY)), 1)
          await requestResult(transaction.objectStore(KEPT_STORE).put(encodeKeptEntries(entries), batch))
          await requestResult(meta.put(batch + 1, NEXT_KEPT_KEY))
        })
      }),

    keptEntries: () =>
      guarded(() =>
        inTransaction(database, [KEPT_STORE], 'readonly', async transaction => {
          const batches = await requestResult(transaction.objectStore(KEPT_STORE).getAll())
          const kept: KeptEntry[] = []
          for (const batch of batches) {
            if (batch instanceof Uint8Array) kept.push(...decodeKeptEntries(batch))
          }
          return kept
        }),
      ),

    clearKeptEntries: () =>
      guarded(() =>
        inTransaction(database, [KEPT_STORE], 'readwrite', async transaction => {
          await requestResult(transaction.objectStore(KEPT_STORE).clear())
        }),
      ),

    appendDownload: (entityTag, offset, chunk) =>
      guarded(() =>
        inTransaction(database, [META_STORE, DOWNLOAD_STORE], 'readwrite', async transaction => {
          const meta = transaction.objectStore(META_STORE)
          const chunks = transaction.objectStore(DOWNLOAD_STORE)
          const saved = await requestResult(meta.get(DOWNLOAD_KEY))
          let byteLength = 0
          if (offset === 0) {
            await requestResult(chunks.clear())
          } else if (!isDownloadMeta(saved) || saved.entityTag !== entityTag || saved.byteLength !== offset) {
            throw downloadOutOfOrder(
              entityTag,
              offset,
              isDownloadMeta(saved) && saved.entityTag === entityTag ? saved.byteLength : 0,
            )
          } else {
            byteLength = saved.byteLength
          }
          if (chunk.byteLength > 0) await requestResult(chunks.put(chunk.slice(), offset))
          const next: SavedDownloadMeta = { entityTag, byteLength: byteLength + chunk.byteLength }
          await requestResult(meta.put(next, DOWNLOAD_KEY))
        }),
      ),

    readDownload: () =>
      guarded(async () => {
        const saved = await readMeta(DOWNLOAD_KEY)
        if (!isDownloadMeta(saved) || saved.byteLength === 0) return null
        const offsets = await inTransaction(database, [DOWNLOAD_STORE], 'readonly', transaction =>
          requestResult(transaction.objectStore(DOWNLOAD_STORE).getAllKeys()),
        )
        const ordered = offsets.filter((key): key is number => typeof key === 'number').sort((a, b) => a - b)
        const download: SavedDownload = {
          entityTag: saved.entityTag,
          byteLength: saved.byteLength,
          async *chunks() {
            for (const offset of ordered) yield await readChunk(offset)
          },
        }
        return download
      }),

    clearDownload: () =>
      guarded(() =>
        inTransaction(database, [META_STORE, DOWNLOAD_STORE], 'readwrite', async transaction => {
          await requestResult(transaction.objectStore(DOWNLOAD_STORE).clear())
          await requestResult(transaction.objectStore(META_STORE).delete(DOWNLOAD_KEY))
        }),
      ),

    close: () =>
      serial.run(async () => {
        if (closed) return
        closed = true
        database.close()
      }),
  }
}
