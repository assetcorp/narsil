import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { BlockLength } from './block-map'
import { requestResult } from './connection'

export interface AppendedRecord {
  n: number
  bytes: Uint8Array
}

export interface FileRecords {
  first: Uint8Array
  appended: AppendedRecord[]
}

export function appendKey(key: string, n: number): [string, number] {
  return [key, n]
}

export function appendRecordsOf(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key], [key, []], true, true)
}

export function compactBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
}

export function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return compactBytes(chunks[0])
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function requireBytes(key: string, value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The IndexedDB record of "${key}" holds no bytes`, { key })
}

function requireAppendNumber(key: string, recordKey: IDBValidKey): number {
  const n = Array.isArray(recordKey) && recordKey.length === 2 && recordKey[0] === key ? recordKey[1] : undefined
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1) return n
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `An append record of "${key}" carries no valid position`, {
    key,
  })
}

export async function readRecords(store: IDBObjectStore, key: string): Promise<FileRecords | null> {
  const first = await requestResult(store.get(key))
  if (first === undefined && (await requestResult(store.getKey(key))) === undefined) return null
  const bytes = requireBytes(key, first)
  const range = appendRecordsOf(key)
  const keys = await requestResult(store.getAllKeys(range))
  const values = await requestResult(store.getAll(range))
  if (keys.length !== values.length) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The append records of "${key}" changed during a read`, {
      key,
    })
  }
  const appended: AppendedRecord[] = []
  for (let at = 0; at < keys.length; at++) {
    appended.push({ n: requireAppendNumber(key, keys[at]), bytes: requireBytes(key, values[at]) })
  }
  return { first: bytes, appended }
}

export function lengthsOf(records: FileRecords): BlockLength[] {
  return [
    { n: 0, length: records.first.byteLength },
    ...records.appended.map(record => ({ n: record.n, length: record.bytes.byteLength })),
  ]
}

export type BlockVisitor = (n: number, bytes: Uint8Array) => boolean

function walkCursor(store: IDBObjectStore, key: string, range: IDBKeyRange, visit: BlockVisitor): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range)
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor === null) {
        resolve(true)
        return
      }
      let enough: boolean
      try {
        enough = visit(requireAppendNumber(key, cursor.key), requireBytes(key, cursor.value))
      } catch (error) {
        reject(error)
        return
      }
      if (enough) resolve(false)
      else cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
}

export async function walkBlocks(
  store: IDBObjectStore,
  key: string,
  afterN: number | null,
  visit: BlockVisitor,
): Promise<boolean | null> {
  if (afterN === null) {
    const first = await requestResult(store.get(key))
    if (first === undefined && (await requestResult(store.getKey(key))) === undefined) return null
    if (visit(0, requireBytes(key, first))) return false
    return walkCursor(store, key, appendRecordsOf(key), visit)
  }
  return walkCursor(store, key, IDBKeyRange.bound(appendKey(key, afterN), [key, []], true, true), visit)
}

function blocksChanged(key: string): NarsilError {
  return new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The blocks of "${key}" changed during a read`, { key })
}

export async function readBlocks(
  store: IDBObjectStore,
  key: string,
  wanted: readonly BlockLength[],
): Promise<Map<number, Uint8Array>> {
  const found = new Map<number, Uint8Array>()
  const appended = wanted.filter(block => block.n > 0)
  const reads: Promise<void>[] = []
  if (appended.length < wanted.length) {
    reads.push(
      requestResult(store.get(key)).then(value => {
        found.set(0, requireBytes(key, value))
      }),
    )
  }
  const lowest = appended[0]
  const highest = appended[appended.length - 1]
  if (lowest !== undefined && highest !== undefined) {
    const range = IDBKeyRange.bound(appendKey(key, lowest.n), appendKey(key, highest.n))
    reads.push(
      Promise.all([requestResult(store.getAllKeys(range)), requestResult(store.getAll(range))]).then(
        ([keys, values]) => {
          if (keys.length !== values.length) throw blocksChanged(key)
          for (let at = 0; at < keys.length; at++) {
            found.set(requireAppendNumber(key, keys[at]), requireBytes(key, values[at]))
          }
        },
      ),
    )
  }
  await Promise.all(reads)
  for (const block of wanted) {
    if (found.get(block.n)?.byteLength !== block.length) throw blocksChanged(key)
  }
  return found
}

export function splitIntoBlocks(chunks: readonly Uint8Array[], blockBytes: number): Uint8Array[] {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const blocks: Uint8Array[] = []
  let block = new Uint8Array(Math.min(blockBytes, total))
  let filled = 0
  for (const chunk of chunks) {
    let read = 0
    while (read < chunk.byteLength) {
      const taken = Math.min(block.byteLength - filled, chunk.byteLength - read)
      block.set(chunk.subarray(read, read + taken), filled)
      filled += taken
      read += taken
      total -= taken
      if (filled === block.byteLength && total > 0) {
        blocks.push(block)
        block = new Uint8Array(Math.min(blockBytes, total))
        filled = 0
      }
    }
  }
  blocks.push(block)
  return blocks
}

export function contentOf(records: FileRecords): Uint8Array {
  if (records.appended.length === 0) return records.first
  return joinBytes([records.first, ...records.appended.map(record => record.bytes)])
}

export async function removeRecords(store: IDBObjectStore, key: string): Promise<void> {
  await requestResult(store.delete(appendRecordsOf(key)))
  await requestResult(store.delete(key))
}

export async function replaceRecords(store: IDBObjectStore, key: string, records: FileRecords): Promise<void> {
  await removeRecords(store, key)
  await requestResult(store.put(records.first, key))
  for (const record of records.appended) await requestResult(store.put(record.bytes, appendKey(key, record.n)))
}

export function listKeys(store: IDBObjectStore, prefix: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const keys: string[] = []
    const request = store.openKeyCursor(IDBKeyRange.lowerBound(prefix))
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor === null || typeof cursor.key !== 'string' || !cursor.key.startsWith(prefix)) {
        resolve(keys)
        return
      }
      keys.push(cursor.key)
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
}
