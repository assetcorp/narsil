import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { IndexedDBLocation } from '../../../types/adapters'
import type { DirectoryLock } from '../directory-lock'

const WEB_LOCK_NAME_PREFIX = 'narsil-wal'

const heldWithoutWebLocks = new Set<string>()

export function webLockNameOf(location: IndexedDBLocation): string {
  return `${WEB_LOCK_NAME_PREFIX}${JSON.stringify([location.databaseName, location.storeName])}`
}

function heldElsewhere(location: IndexedDBLocation): NarsilError {
  return new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `Another tab or engine holds the write-ahead log of IndexedDB database "${location.databaseName}" store "${location.storeName}". Several tabs that share one store need an invalidation adapter or durability.tier "snapshot"`,
    { databaseName: location.databaseName, storeName: location.storeName },
  )
}

function lockWithinProcess(name: string, location: IndexedDBLocation): DirectoryLock {
  if (heldWithoutWebLocks.has(name)) throw heldElsewhere(location)
  heldWithoutWebLocks.add(name)
  let held = true
  return {
    holds: async () => held,
    async release() {
      if (!held) return
      held = false
      heldWithoutWebLocks.delete(name)
    },
  }
}

function lockAcrossTabs(locks: LockManager, name: string, location: IndexedDBLocation): Promise<DirectoryLock> {
  return new Promise((resolve, reject) => {
    let held = false
    let releaseLock: () => void = () => undefined
    const releasing = new Promise<void>(settle => {
      releaseLock = settle
    })
    locks
      .request(name, { mode: 'exclusive', ifAvailable: true }, granted => {
        if (granted === null) {
          reject(heldElsewhere(location))
          return undefined
        }
        held = true
        resolve({
          holds: async () => held,
          async release() {
            held = false
            releaseLock()
          },
        })
        return releasing
      })
      .then(
        () => {
          held = false
        },
        error => {
          held = false
          reject(error)
        },
      )
  })
}

export function lockIndexedDBStore(location: IndexedDBLocation): Promise<DirectoryLock> {
  const name = webLockNameOf(location)
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
  if (locks === undefined) return Promise.resolve().then(() => lockWithinProcess(name, location))
  return lockAcrossTabs(locks, name, location)
}
