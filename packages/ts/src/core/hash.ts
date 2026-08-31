const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

const encoder = new TextEncoder()

/**
 * Hashes a byte sequence with FNV-1a, as the specification's algorithms
 * section defines it. Partition routing and cursor binding both build on it.
 *
 * @param bytes - The bytes to hash.
 * @returns The 32-bit hash, as an unsigned integer.
 */
export function fnv1aBytes(bytes: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, FNV_PRIME)
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
