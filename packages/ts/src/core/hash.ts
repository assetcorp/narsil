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

const scratchNumber = new Float64Array(1)
const scratchBytes = new Uint8Array(scratchNumber.buffer)
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

export function fnv1aContinueTaggedNumbers(start: number, tag: number, numbers: ArrayLike<number>): number {
  let hash = start
  const b = scratchBytes
  for (let i = 0; i < numbers.length; i++) {
    scratchNumber[0] = Math.fround(numbers[i])
    hash = Math.imul(hash ^ tag, FNV_PRIME)
    if (HOST_IS_LITTLE_ENDIAN) {
      hash = Math.imul(hash ^ b[7], FNV_PRIME)
      hash = Math.imul(hash ^ b[6], FNV_PRIME)
      hash = Math.imul(hash ^ b[5], FNV_PRIME)
      hash = Math.imul(hash ^ b[4], FNV_PRIME)
      hash = Math.imul(hash ^ b[3], FNV_PRIME)
      hash = Math.imul(hash ^ b[2], FNV_PRIME)
      hash = Math.imul(hash ^ b[1], FNV_PRIME)
      hash = Math.imul(hash ^ b[0], FNV_PRIME)
    } else {
      for (let at = 0; at < 8; at++) hash = Math.imul(hash ^ b[at], FNV_PRIME)
    }
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
