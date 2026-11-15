import { ErrorCodes, NarsilError } from '#platform/storage-host'
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
