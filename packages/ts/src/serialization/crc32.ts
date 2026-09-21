import { nativeCrc32 } from '#platform/native-crc32'
import { NATIVE_CRC32_MIN_BYTES } from './constants'

const IEEE_POLYNOMIAL = 0xedb88320
const ALL_BITS = 0xffffffff

let cachedTable: Uint32Array | null = null

function buildTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ IEEE_POLYNOMIAL : crc >>> 1
    }
    table[i] = crc
  }
  return table
}

function getTable(): Uint32Array {
  if (cachedTable === null) {
    cachedTable = buildTable()
  }
  return cachedTable
}

export function crc32(data: Uint8Array): number {
  return crc32Final(crc32Update(crc32Init(), data))
}

export function crc32Init(): number {
  return ALL_BITS
}

export function crc32Update(state: number, data: Uint8Array): number {
  if (nativeCrc32 !== null && data.length >= NATIVE_CRC32_MIN_BYTES) {
    return nativeCrc32(data, (state ^ ALL_BITS) >>> 0) ^ ALL_BITS
  }
  const table = getTable()
  let crc = state
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff]
  }
  return crc
}

export function crc32Final(state: number): number {
  return (state ^ ALL_BITS) >>> 0
}
