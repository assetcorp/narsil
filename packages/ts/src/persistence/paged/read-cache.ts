import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { NativePageCache } from '../../vector/native/types/paged'
import { createAsyncPageCaches } from './async-page-cache'
import {
  LARGEST_CACHED_ENTRY_SHARE,
  MAX_THREAD_FILE_NUMBER,
  NATIVE_PAGE_CACHE_SHARE,
  THREAD_READ_CACHE_BYTES,
} from './constants'
import { createPageCache, pageCacheBytes, pageCacheFileBytes, releasePageFile } from './page-cache'

const FILE_NUMBER_SCALE = 2 ** 34
const ENTRY_NUMBER_SCALE = 4

export const CACHED_PAGE = 0
export const CACHED_LIST = 1
export const CACHED_POSITIONS = 2
export const CACHED_DOCUMENT_BLOCK = 3

export type CachedKind =
  | typeof CACHED_PAGE
  | typeof CACHED_LIST
  | typeof CACHED_POSITIONS
  | typeof CACHED_DOCUMENT_BLOCK

interface CacheEntry {
  value: unknown
  bytes: number
  fileNumber: number
  referenced: boolean
}

export interface ReadCache {
  readonly bytes: number
  readonly capacity: number
  pageCache(): NativePageCache
  withPageCache<T>(read: (cache: NativePageCache) => Promise<T>): Promise<T>
  releasePageFile(identity: bigint): void
  fileNumber(): number
  bytesOfFile(fileNumber: number): number
  bytesOfPageFile(identity: bigint): number
  get<Value>(fileNumber: number, kind: CachedKind, entry: number): Value | undefined
  put(fileNumber: number, kind: CachedKind, entry: number, value: unknown, bytes: number): void
  releaseFile(fileNumber: number): void
  clear(): void
}

export function createReadCache(capacity: number): ReadCache {
  const entries = new Map<number, CacheEntry>()
  const perFile = new Map<number, number>()
  const freedFileNumbers: number[] = []
  let held = 0
  let pages: NativePageCache | null = null
  let reserved = 0
  let nextFileNumber = 1
  const asyncPages = createAsyncPageCaches(capacity * NATIVE_PAGE_CACHE_SHARE, bytes => {
    reserved += bytes
    evictDownTo(capacity - reserved)
  })

  function drop(key: number, entry: CacheEntry): void {
    entries.delete(key)
    held -= entry.bytes
    const remaining = (perFile.get(entry.fileNumber) ?? 0) - entry.bytes
    if (remaining <= 0) perFile.delete(entry.fileNumber)
    else perFile.set(entry.fileNumber, remaining)
  }

  function evictDownTo(limit: number): void {
    for (const [key, entry] of entries) {
      if (held <= limit) return
      if (entry.referenced) {
        entry.referenced = false
        entries.delete(key)
        entries.set(key, entry)
        continue
      }
      drop(key, entry)
    }
  }

  function clear(): void {
    entries.clear()
    perFile.clear()
    held = 0
    if (pages !== null) reserved -= pageCacheBytes(pages)
    pages = null
    asyncPages.clear()
  }

  return {
    get bytes() {
      return held + reserved
    },
    capacity,

    pageCache(): NativePageCache {
      if (pages === null) {
        const created = createPageCache(capacity * NATIVE_PAGE_CACHE_SHARE)
        reserved += pageCacheBytes(created)
        evictDownTo(capacity - reserved)
        pages = created
      }
      return pages
    },

    withPageCache: asyncPages.withCache,

    releasePageFile(identity: bigint): void {
      if (pages !== null) releasePageFile(pages, identity)
      asyncPages.releaseFile(identity)
    },

    fileNumber(): number {
      const freed = freedFileNumbers.pop()
      if (freed !== undefined) return freed
      if (nextFileNumber >= MAX_THREAD_FILE_NUMBER) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_LOAD_FAILED,
          `This thread holds ${nextFileNumber} open segment files, which is the most that its read cache can tell apart`,
          { limit: MAX_THREAD_FILE_NUMBER },
        )
      }
      const number = nextFileNumber
      nextFileNumber += 1
      return number
    },

    bytesOfFile(fileNumber: number): number {
      return perFile.get(fileNumber) ?? 0
    },

    bytesOfPageFile(identity: bigint): number {
      return (pages === null ? 0 : pageCacheFileBytes(pages, identity)) + asyncPages.bytesOfFile(identity)
    },

    get<Value>(fileNumber: number, kind: CachedKind, entry: number): Value | undefined {
      const key = fileNumber * FILE_NUMBER_SCALE + entry * ENTRY_NUMBER_SCALE + kind
      const found = entries.get(key)
      if (found === undefined) return undefined
      found.referenced = true
      return found.value as Value
    },

    put(fileNumber: number, kind: CachedKind, entry: number, value: unknown, bytes: number): void {
      if (bytes > capacity * LARGEST_CACHED_ENTRY_SHARE) return
      const key = fileNumber * FILE_NUMBER_SCALE + entry * ENTRY_NUMBER_SCALE + kind
      const existing = entries.get(key)
      if (existing !== undefined) drop(key, existing)
      entries.set(key, { value, bytes, fileNumber, referenced: true })
      held += bytes
      perFile.set(fileNumber, (perFile.get(fileNumber) ?? 0) + bytes)
      evictDownTo(capacity - reserved)
    },

    releaseFile(fileNumber: number): void {
      freedFileNumbers.push(fileNumber)
      if (!perFile.has(fileNumber)) return
      for (const [key, entry] of entries) {
        if (entry.fileNumber === fileNumber) drop(key, entry)
      }
    },

    clear,
  }
}

let threadCache: ReadCache | null = null

export function readCacheOfThisThread(): ReadCache {
  threadCache ??= createReadCache(THREAD_READ_CACHE_BYTES)
  return threadCache
}
