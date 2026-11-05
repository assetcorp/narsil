import { ErrorCodes, NarsilError } from '../../../errors'
import { INDEXEDDB_DEVICE_STORE_BLOCKED_TIMEOUT_MS } from '../constants'

export const META_STORE = 'meta'
export const QUEUE_STORE = 'queue'
export const KEPT_STORE = 'kept'
export const DOWNLOAD_STORE = 'download'
const SCHEMA_VERSION = 1

function storeFailed(action: string, cause: { message: string } | null): NarsilError {
  return new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `The device sync store could not ${action}: ${cause?.message ?? 'unknown error'}`,
  )
}

export function openDeviceDatabase(name: string): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new NarsilError(ErrorCodes.CONFIG_INVALID, 'IndexedDB is not available, so use createFilesystemDeviceStore'),
    )
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, SCHEMA_VERSION)
    let blockedTimer: ReturnType<typeof setTimeout> | null = null
    request.onblocked = () => {
      blockedTimer = setTimeout(
        () => reject(storeFailed(`open "${name}" while another tab holds an older version`, null)),
        INDEXEDDB_DEVICE_STORE_BLOCKED_TIMEOUT_MS,
      )
    }
    request.onupgradeneeded = () => {
      const database = request.result
      for (const store of [META_STORE, QUEUE_STORE, KEPT_STORE, DOWNLOAD_STORE]) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store)
      }
    }
    request.onsuccess = () => {
      if (blockedTimer !== null) clearTimeout(blockedTimer)
      resolve(request.result)
    }
    request.onerror = () => {
      if (blockedTimer !== null) clearTimeout(blockedTimer)
      reject(storeFailed(`open "${name}"`, request.error))
    }
  })
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(storeFailed('read', request.error))
  })
}

export function inTransaction<T>(
  database: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(stores, mode, { durability: 'strict' })
  const committed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(storeFailed('save', transaction.error))
    transaction.onabort = () => reject(storeFailed('save', transaction.error))
  })
  return body(transaction).then(
    async result => {
      await committed
      return result
    },
    async error => {
      try {
        transaction.abort()
      } catch {}
      await committed.catch(() => undefined)
      throw error
    },
  )
}
