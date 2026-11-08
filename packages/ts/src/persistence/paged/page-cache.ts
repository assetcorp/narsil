import type { NativePageCache } from '../../vector/native/types/paged'
import { createFixedBuffer } from '../../vector/shared-buffers/growable'

const SLOT_BYTES = 65_536
const SLOT_METADATA_BYTES = 3 * BigUint64Array.BYTES_PER_ELEMENT + 2 * Uint32Array.BYTES_PER_ELEMENT

export function createPageCache(capacity: number, shared = false): NativePageCache {
  const slots = Math.floor(capacity / (SLOT_BYTES + SLOT_METADATA_BYTES))
  const allocate = (bytes: number): ArrayBufferLike => (shared ? createFixedBuffer(bytes) : new ArrayBuffer(bytes))
  return {
    bytes: new Uint8Array(allocate(slots * SLOT_BYTES)),
    files: new BigUint64Array(allocate(slots * BigUint64Array.BYTES_PER_ELEMENT)),
    offsets: new BigUint64Array(allocate(slots * BigUint64Array.BYTES_PER_ELEMENT)),
    pages: new BigUint64Array(allocate(slots * BigUint64Array.BYTES_PER_ELEMENT)),
    lengths: new Uint32Array(allocate(slots * Uint32Array.BYTES_PER_ELEMENT)),
    checksums: new Uint32Array(allocate(slots * Uint32Array.BYTES_PER_ELEMENT)),
  }
}

export function pageCacheBytes(cache: NativePageCache): number {
  return (
    cache.bytes.byteLength +
    cache.files.byteLength +
    cache.offsets.byteLength +
    cache.pages.byteLength +
    cache.lengths.byteLength +
    cache.checksums.byteLength
  )
}

export function pageCacheBytesByFile(cache: NativePageCache): Map<bigint, number> {
  const bytes = new Map<bigint, number>()
  for (const identity of cache.files) {
    if (identity !== 0n) bytes.set(identity, (bytes.get(identity) ?? 0) + SLOT_BYTES + SLOT_METADATA_BYTES)
  }
  return bytes
}

export function pageCacheFileBytes(cache: NativePageCache, identity: bigint): number {
  let bytes = 0
  for (const held of cache.files) {
    if (held === identity) bytes += SLOT_BYTES + SLOT_METADATA_BYTES
  }
  return bytes
}

export function releasePageFile(cache: NativePageCache, identity: bigint): void {
  for (let at = 0; at < cache.files.length; at++) {
    if (cache.files[at] === identity) cache.files[at] = 0n
  }
}
