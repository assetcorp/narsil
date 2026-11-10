import type { NativePageCache } from '../../vector/native/types/paged'
import { NATIVE_ASYNC_PAGE_CACHES } from './constants'
import { createPageCache, pageCacheBytes, pageCacheBytesByFile, releasePageFile } from './page-cache'

interface CacheLease {
  cache: NativePageCache
  active: boolean
  discard: boolean
  releasedFiles: Set<bigint>
  bytesByFile: Map<bigint, number>
}

export function createAsyncPageCaches(capacity: number, account: (bytes: number) => void) {
  const leases = new Set<CacheLease>()

  function release(lease: CacheLease): void {
    lease.active = false
    if (lease.discard) {
      leases.delete(lease)
      account(-pageCacheBytes(lease.cache))
    } else {
      for (const identity of lease.releasedFiles) releasePageFile(lease.cache, identity)
      lease.bytesByFile = pageCacheBytesByFile(lease.cache)
    }
    lease.releasedFiles.clear()
  }

  return {
    async withCache<T>(read: (cache: NativePageCache) => Promise<T>): Promise<T> {
      let lease: CacheLease | undefined
      for (const available of leases) {
        if (!available.active) {
          lease = available
          break
        }
      }
      if (lease === undefined) {
        const retained = leases.size < NATIVE_ASYNC_PAGE_CACHES
        const cache = createPageCache(retained ? capacity / NATIVE_ASYNC_PAGE_CACHES : 0, true)
        lease = { cache, active: false, discard: !retained, releasedFiles: new Set(), bytesByFile: new Map() }
        leases.add(lease)
        account(pageCacheBytes(cache))
      }
      lease.active = true
      try {
        return await read(lease.cache)
      } finally {
        release(lease)
      }
    },
    releaseFile(identity: bigint): void {
      for (const lease of leases) {
        lease.bytesByFile.delete(identity)
        if (lease.active) lease.releasedFiles.add(identity)
        else releasePageFile(lease.cache, identity)
      }
    },
    bytesOfFile(identity: bigint): number {
      let bytes = 0
      for (const lease of leases) bytes += lease.bytesByFile.get(identity) ?? 0
      return bytes
    },
    clear(): void {
      for (const lease of leases) {
        lease.discard = true
        if (!lease.active) release(lease)
      }
    },
  }
}
