import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { ErrorCode } from '../../../errors'
import type { IndexedDBLocation } from '../../../types/adapters'
import { INDEXEDDB_BLOCKED_TIMEOUT_MS } from '../../constants'

export type CommitDurability = 'strict' | 'relaxed'

export interface StoreFailure {
  code: ErrorCode
  action: string
}

export interface LogConnection {
  readonly root: string
  read<T>(failure: StoreFailure, body: (store: IDBObjectStore) => Promise<T>): Promise<T>
  write<T>(durability: CommitDurability, failure: StoreFailure, body: (store: IDBObjectStore) => Promise<T>): Promise<T>
  identity(): Promise<string | null>
  close(): void
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function causeOf(error: unknown): string {
  if (error instanceof Error || (typeof error === 'object' && error !== null && 'message' in error)) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

export function rootOf(location: IndexedDBLocation): string {
  return `indexeddb:${location.databaseName}/${location.storeName}`
}

export function openLogConnection(location: IndexedDBLocation): LogConnection {
  const root = rootOf(location)
  let opening: Promise<IDBDatabase> | null = null
  let lostReason: string | null = null
  let closedByEngine = false
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  function storeFailed(failure: StoreFailure, cause: string): NarsilError {
    return new NarsilError(failure.code, `IndexedDB could not ${failure.action} in ${root}: ${cause}`, {
      directory: root,
      cause,
    })
  }

  function replaced(): NarsilError {
    return new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine treats ${root} as replaced, because ${lostReason ?? 'the engine closed it'}, so it acknowledges no later write`,
      { directory: root },
    )
  }

  function watch(database: IDBDatabase): void {
    database.onclose = () => {
      lostReason ??= 'the browser closed the connection'
    }
    database.onversionchange = () => {
      lostReason ??= 'another connection asked for a version change of the database'
      database.close()
    }
  }

  function open(): Promise<IDBDatabase> {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (factory === undefined) {
      return Promise.reject(
        new NarsilError(ErrorCodes.CONFIG_INVALID, 'IndexedDB is not available, so the write-ahead log cannot open'),
      )
    }
    return new Promise((resolve, reject) => {
      const request = factory.open(location.databaseName)
      let blockedTimer: ReturnType<typeof setTimeout> | null = null
      const settle = () => {
        if (blockedTimer !== null) clearTimeout(blockedTimer)
      }
      request.onblocked = () => {
        blockedTimer = setTimeout(
          () =>
            reject(storeFailed({ code: ErrorCodes.PERSISTENCE_SAVE_FAILED, action: 'open' }, 'the open is blocked')),
          INDEXEDDB_BLOCKED_TIMEOUT_MS,
        )
      }
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(location.storeName)) database.createObjectStore(location.storeName)
      }
      request.onsuccess = () => {
        settle()
        const database = request.result
        if (!database.objectStoreNames.contains(location.storeName)) {
          database.close()
          reject(
            storeFailed(
              { code: ErrorCodes.PERSISTENCE_SAVE_FAILED, action: 'open' },
              `the database holds no object store named "${location.storeName}"`,
            ),
          )
          return
        }
        watch(database)
        resolve(database)
      }
      request.onerror = () => {
        settle()
        reject(storeFailed({ code: ErrorCodes.PERSISTENCE_SAVE_FAILED, action: 'open' }, causeOf(request.error)))
      }
    })
  }

  async function database(): Promise<IDBDatabase> {
    if (closedByEngine || lostReason !== null) throw replaced()
    if (opening === null) {
      opening = open()
      opening.catch(() => {
        opening = null
      })
    }
    const opened = await opening
    if (lostReason !== null || closedByEngine) throw replaced()
    return opened
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    durability: CommitDurability | null,
    failure: StoreFailure,
    body: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const opened = await database()
    let transaction: IDBTransaction
    try {
      transaction =
        durability === null
          ? opened.transaction(location.storeName, mode)
          : opened.transaction(location.storeName, mode, { durability })
    } catch (error) {
      if (lostReason === null && (error as { name?: unknown }).name === 'InvalidStateError') {
        lostReason = 'the browser closed the connection'
      }
      throw lostReason === null ? storeFailed(failure, causeOf(error)) : replaced()
    }
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('the transaction aborted'))
    })
    let result: T
    try {
      result = await body(transaction.objectStore(location.storeName))
    } catch (error) {
      try {
        transaction.abort()
      } catch {}
      await committed.catch(() => undefined)
      throw transactionFailed(transaction, failure, error)
    }
    try {
      await committed
    } catch (error) {
      throw transactionFailed(transaction, failure, error)
    }
    if (lostReason !== null || closedByEngine) throw replaced()
    return result
  }

  function transactionFailed(transaction: IDBTransaction, failure: StoreFailure, error: unknown): NarsilError {
    const aborted = transaction.error?.name === 'AbortError' || (error instanceof Error && error.name === 'AbortError')
    if (lostReason === null && aborted) {
      lostReason = 'the browser closed the connection'
    }
    if (lostReason !== null || closedByEngine) return replaced()
    return error instanceof NarsilError ? error : storeFailed(failure, causeOf(error))
  }

  return {
    root,
    read: (failure, body) => transact('readonly', null, failure, body),
    write: (durability, failure, body) => transact('readwrite', durability, failure, body),
    async identity(): Promise<string | null> {
      await database().catch(error => {
        if (lostReason === null && !closedByEngine) throw error
      })
      return lostReason === null && !closedByEngine ? token : null
    },
    close(): void {
      closedByEngine = true
      const pending = opening
      opening = null
      void pending?.then(
        opened => opened.close(),
        () => undefined,
      )
    },
  }
}
