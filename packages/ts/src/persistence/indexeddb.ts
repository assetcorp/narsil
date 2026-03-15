import { ErrorCodes, NarsilError } from '../errors'
import type { PersistenceAdapter } from '../types/adapters'

declare const indexedDB: {
  open(name: string, version?: number): IDBOpenDBRequest
}

interface IDBOpenDBRequest {
  result: IDBDatabaseInstance
  error: { message: string } | null
  onblocked: (() => void) | null
  onupgradeneeded: (() => void) | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

interface IDBDatabaseInstance {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): void
  transaction(storeName: string, mode: 'readonly' | 'readwrite'): IDBTransactionInstance
}

interface IDBTransactionInstance {
  objectStore(name: string): IDBObjectStoreInstance
}

interface IDBObjectStoreInstance {
  put(value: unknown, key: string): IDBRequestInstance
  get(key: string): IDBRequestInstance
  delete(key: string): IDBRequestInstance
  openCursor(range?: IDBKeyRangeInstance): IDBCursorRequestInstance
}

interface IDBRequestInstance {
  result: unknown
  error: { message: string } | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

interface IDBCursorRequestInstance {
  result: { key: string; continue(): void } | null
  error: { message: string } | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

declare const IDBKeyRange: {
  bound(lower: string, upper: string): IDBKeyRangeInstance
}

type IDBKeyRangeInstance = {}

export interface IndexedDBPersistenceConfig {
  dbName?: string
  storeName?: string
}

const DEFAULT_DB_NAME = 'narsil'
const DEFAULT_STORE_NAME = 'partitions'
const MAX_KEY_LENGTH = 1024
const BLOCKED_TIMEOUT_MS = 5000

function validateKey(key: string): void {
  if (!key || key.length === 0) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Key must be a non-empty string')
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Key length ${key.length} exceeds maximum of ${MAX_KEY_LENGTH}`,
    )
  }
}

export function createIndexedDBPersistence(config?: IndexedDBPersistenceConfig): PersistenceAdapter {
  const dbName = config?.dbName ?? DEFAULT_DB_NAME
  const storeName = config?.storeName ?? DEFAULT_STORE_NAME

  let cachedDb: IDBDatabaseInstance | null = null

  function openDatabase(): Promise<IDBDatabaseInstance> {
    if (cachedDb !== null) {
      return Promise.resolve(cachedDb)
    }

    return new Promise<IDBDatabaseInstance>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)

      let blockedTimer: ReturnType<typeof setTimeout> | null = null

      request.onblocked = () => {
        blockedTimer = setTimeout(() => {
          reject(
            new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `IndexedDB open blocked for ${BLOCKED_TIMEOUT_MS}ms`),
          )
        }, BLOCKED_TIMEOUT_MS)
      }

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName)
        }
      }

      request.onsuccess = () => {
        if (blockedTimer !== null) {
          clearTimeout(blockedTimer)
        }
        cachedDb = request.result
        resolve(cachedDb)
      }

      request.onerror = () => {
        if (blockedTimer !== null) {
          clearTimeout(blockedTimer)
        }
        reject(
          new NarsilError(
            ErrorCodes.PERSISTENCE_SAVE_FAILED,
            `Failed to open IndexedDB: ${request.error?.message ?? 'unknown error'}`,
          ),
        )
      }
    })
  }

  return {
    async save(key: string, data: Uint8Array): Promise<void> {
      validateKey(key)
      const db = await openDatabase()
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const request = store.put(data, key)

        request.onsuccess = () => resolve()
        request.onerror = () =>
          reject(
            new NarsilError(
              ErrorCodes.PERSISTENCE_SAVE_FAILED,
              `Failed to save key "${key}": ${request.error?.message ?? 'unknown error'}`,
            ),
          )
      })
    },

    async load(key: string): Promise<Uint8Array | null> {
      validateKey(key)
      const db = await openDatabase()
      return new Promise<Uint8Array | null>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const request = store.get(key)

        request.onsuccess = () => {
          const result = request.result
          if (result === undefined) {
            resolve(null)
          } else {
            resolve(result as Uint8Array)
          }
        }
        request.onerror = () =>
          reject(
            new NarsilError(
              ErrorCodes.PERSISTENCE_LOAD_FAILED,
              `Failed to load key "${key}": ${request.error?.message ?? 'unknown error'}`,
            ),
          )
      })
    },

    async delete(key: string): Promise<void> {
      validateKey(key)
      const db = await openDatabase()
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const request = store.delete(key)

        request.onsuccess = () => resolve()
        request.onerror = () =>
          reject(
            new NarsilError(
              ErrorCodes.PERSISTENCE_DELETE_FAILED,
              `Failed to delete key "${key}": ${request.error?.message ?? 'unknown error'}`,
            ),
          )
      })
    },

    async list(prefix: string): Promise<string[]> {
      const db = await openDatabase()
      return new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`)
        const request = store.openCursor(range)
        const results: string[] = []

        request.onsuccess = () => {
          const cursor = request.result
          if (cursor) {
            results.push(cursor.key as string)
            cursor.continue()
          } else {
            resolve(results)
          }
        }
        request.onerror = () =>
          reject(
            new NarsilError(
              ErrorCodes.PERSISTENCE_LOAD_FAILED,
              `Failed to list keys with prefix "${prefix}": ${request.error?.message ?? 'unknown error'}`,
            ),
          )
      })
    },
  }
}
