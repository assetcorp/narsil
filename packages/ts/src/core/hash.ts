export const FNV_OFFSET_BASIS = 0x811c9dc5
export const FNV_PRIME = 0x01000193

const encoder = new TextEncoder()

/**
 * Hashes a byte sequence with FNV-1a, as the specification's algorithms
 * section defines it. Partition routing and cursor binding both build on it.
 *
 * @param bytes - The bytes to hash.
 * @returns The 32-bit hash, as an unsigned integer.
 */
export function fnv1aBytes(bytes: Uint8Array): number {
  return fnv1aContinue(FNV_OFFSET_BASIS, bytes, bytes.length) >>> 0
}

export function fnv1aContinue(start: number, bytes: Uint8Array, length: number): number {
  let hash = start
  for (let i = 0; i < length; i++) {
    hash = Math.imul(hash ^ bytes[i], FNV_PRIME)
  }
  return hash
}

export function fnv1aUint32s(values: readonly number[]): number {
  let hash = FNV_OFFSET_BASIS
  for (const value of values) {
    for (let shift = 24; shift >= 0; shift -= 8) {
      hash ^= (value >>> shift) & 0xff
      hash = Math.imul(hash, FNV_PRIME)
    }
  }
  return hash >>> 0
}

/**
 * Hashes a string with FNV-1a over its UTF-8 bytes, which is how a document ID
 * routes to its partition.
 *
 * @param input - The string to hash.
 * @returns The 32-bit hash, as an unsigned integer.
 */
export function fnv1a(input: string): number {
  return fnv1aBytes(encoder.encode(input))
}
