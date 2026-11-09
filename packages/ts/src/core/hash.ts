export const FNV_OFFSET_BASIS = 0x811c9dc5
export const FNV_PRIME = 0x01000193

const UTF8_REPLACEMENT_CHARACTER = 0xfffd

export function fnv1aUtf16(text: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at)
    hash = Math.imul(hash ^ (unit & 255), FNV_PRIME)
    hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME)
  }
  return hash >>> 0
}

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
const scratchWords = new Int32Array(scratchNumber.buffer)
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
const FNV_PRIME_FOURTH_POWER = 0x502c3f11

export function fnv1aContinueTaggedNumbers(start: number, tag: number, numbers: ArrayLike<number>): number {
  let hash = start
  for (let i = 0; i < numbers.length; i++) {
    scratchNumber[0] = Math.fround(numbers[i])
    const low = scratchWords[HOST_IS_LITTLE_ENDIAN ? 0 : 1]
    const high = scratchWords[HOST_IS_LITTLE_ENDIAN ? 1 : 0]
    hash = Math.imul(hash ^ tag, FNV_PRIME)
    hash = Math.imul(hash ^ (high >>> 24), FNV_PRIME)
    hash = Math.imul(hash ^ ((high >>> 16) & 0xff), FNV_PRIME)
    hash = Math.imul(hash ^ ((high >>> 8) & 0xff), FNV_PRIME)
    hash = Math.imul(hash ^ (high & 0xff), FNV_PRIME)
    if ((low & 0x00ffffff) === 0) hash = Math.imul(hash ^ (low >>> 24), FNV_PRIME_FOURTH_POWER)
    else {
      hash = Math.imul(hash ^ (low >>> 24), FNV_PRIME)
      hash = Math.imul(hash ^ ((low >>> 16) & 0xff), FNV_PRIME)
      hash = Math.imul(hash ^ ((low >>> 8) & 0xff), FNV_PRIME)
      hash = Math.imul(hash ^ (low & 0xff), FNV_PRIME)
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
  let hash = FNV_OFFSET_BASIS
  const length = input.length
  for (let at = 0; at < length; at++) {
    let point = input.charCodeAt(at)
    if (point < 0x80) {
      hash = Math.imul(hash ^ point, FNV_PRIME)
      continue
    }
    if (point >= 0xd800 && point <= 0xdfff) {
      const next = point <= 0xdbff && at + 1 < length ? input.charCodeAt(at + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (next - 0xdc00)
        at++
      } else point = UTF8_REPLACEMENT_CHARACTER
    }
    if (point < 0x800) {
      hash = Math.imul(hash ^ (0xc0 | (point >>> 6)), FNV_PRIME)
    } else if (point < 0x10000) {
      hash = Math.imul(hash ^ (0xe0 | (point >>> 12)), FNV_PRIME)
      hash = Math.imul(hash ^ (0x80 | ((point >>> 6) & 0x3f)), FNV_PRIME)
    } else {
      hash = Math.imul(hash ^ (0xf0 | (point >>> 18)), FNV_PRIME)
      hash = Math.imul(hash ^ (0x80 | ((point >>> 12) & 0x3f)), FNV_PRIME)
      hash = Math.imul(hash ^ (0x80 | ((point >>> 6) & 0x3f)), FNV_PRIME)
    }
    hash = Math.imul(hash ^ (0x80 | (point & 0x3f)), FNV_PRIME)
  }
  return hash >>> 0
}
