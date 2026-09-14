import type { OsqBits, OsqCode } from './quantize'

const OSQ_RECORD_TRAILER_BYTES = 16
const TRAILER_LOWER = 0
const TRAILER_UPPER = 4
const TRAILER_CORRECTION = 8
const TRAILER_SUM = 12

export function osqCodeBytes(dimension: number, bits: OsqBits): number {
  return bits === 8 ? dimension : bits * Math.ceil(dimension / 8)
}

export function osqRecordBytes(dimension: number, bits: OsqBits): number {
  return osqCodeBytes(dimension, bits) + OSQ_RECORD_TRAILER_BYTES
}

export function packLevels(levels: Uint8Array, bits: OsqBits, target: Uint8Array, offset: number): void {
  const dimension = levels.length
  if (bits === 8) {
    target.set(levels, offset)
    return
  }
  const planeBytes = Math.ceil(dimension / 8)
  target.fill(0, offset, offset + bits * planeBytes)
  for (let i = 0; i < dimension; i++) {
    const value = levels[i]
    if (value === 0) continue
    const byte = offset + (i >> 3)
    const mask = 1 << (7 - (i & 7))
    for (let j = 0; j < bits; j++) {
      if ((value >> j) & 1) target[byte + j * planeBytes] |= mask
    }
  }
}

export function unpackLevels(bytes: Uint8Array, offset: number, dimension: number, bits: OsqBits): Uint8Array {
  const levels = new Uint8Array(dimension)
  if (bits === 8) {
    levels.set(bytes.subarray(offset, offset + dimension))
    return levels
  }
  const planeBytes = Math.ceil(dimension / 8)
  for (let i = 0; i < dimension; i++) {
    const byte = offset + (i >> 3)
    const shift = 7 - (i & 7)
    let value = 0
    for (let j = 0; j < bits; j++) value |= ((bytes[byte + j * planeBytes] >> shift) & 1) << j
    levels[i] = value
  }
  return levels
}

export function writeRecord(
  target: Uint8Array,
  offset: number,
  code: OsqCode,
  bits: OsqBits,
  trailer: DataView = new DataView(target.buffer, target.byteOffset, target.byteLength),
): void {
  packLevels(code.levels, bits, target, offset)
  const at = offset + osqCodeBytes(code.levels.length, bits)
  trailer.setFloat32(at + TRAILER_LOWER, code.lower, true)
  trailer.setFloat32(at + TRAILER_UPPER, code.upper, true)
  trailer.setFloat32(at + TRAILER_CORRECTION, code.correction, true)
  trailer.setUint32(at + TRAILER_SUM, code.sum, true)
}

export interface OsqTrailer {
  lower: number
  upper: number
  correction: number
  sum: number
}

export function readTrailer(trailer: DataView, codeOffset: number, codeBytes: number, into: OsqTrailer): OsqTrailer {
  const at = codeOffset + codeBytes
  into.lower = trailer.getFloat32(at + TRAILER_LOWER, true)
  into.upper = trailer.getFloat32(at + TRAILER_UPPER, true)
  into.correction = trailer.getFloat32(at + TRAILER_CORRECTION, true)
  into.sum = trailer.getUint32(at + TRAILER_SUM, true)
  return into
}

export function readRecord(bytes: Uint8Array, offset: number, dimension: number, bits: OsqBits): OsqCode {
  const trailer = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const values = readTrailer(trailer, offset, osqCodeBytes(dimension, bits), {
    lower: 0,
    upper: 0,
    correction: 0,
    sum: 0,
  })
  return { levels: unpackLevels(bytes, offset, dimension, bits), ...values }
}
