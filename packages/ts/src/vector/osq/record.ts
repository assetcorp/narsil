import type { OsqBits, OsqCode } from './quantize'

const OSQ_RECORD_TRAILER_BYTES = 16
const TRAILER_LOWER = 0
const TRAILER_UPPER = 4
const TRAILER_CORRECTION = 8
const TRAILER_SUM = 12

const QUERY_PLANES_FOR_NARROW_CODES = 4
const LEVELS_IN_A_TWO_BIT_BYTE = 4

export function osqCodeBytes(dimension: number, bits: OsqBits): number {
  return Math.ceil((dimension * bits) / 8)
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
  const perByte = 8 / bits
  target.fill(0, offset, offset + osqCodeBytes(dimension, bits))
  for (let i = 0; i < dimension; i++) {
    const value = levels[i]
    if (value === 0) continue
    target[offset + Math.floor(i / perByte)] |= value << ((i % perByte) * bits)
  }
}

export function unpackLevels(bytes: Uint8Array, offset: number, dimension: number, bits: OsqBits): Uint8Array {
  const levels = new Uint8Array(dimension)
  if (bits === 8) {
    levels.set(bytes.subarray(offset, offset + dimension))
    return levels
  }
  const perByte = 8 / bits
  const mask = (1 << bits) - 1
  for (let i = 0; i < dimension; i++) {
    levels[i] = (bytes[offset + Math.floor(i / perByte)] >> ((i % perByte) * bits)) & mask
  }
  return levels
}

export function osqStagedQueryBytes(dimension: number, documentBits: OsqBits): number {
  if (documentBits === 8) return dimension
  if (documentBits === 4) return osqCodeBytes(dimension, 4)
  return QUERY_PLANES_FOR_NARROW_CODES * osqCodeBytes(dimension, documentBits)
}

export function stageQueryLevels(levels: Uint8Array, documentBits: OsqBits, target: Uint8Array): void {
  if (documentBits === 8 || documentBits === 4) {
    packLevels(levels, documentBits, target, 0)
    return
  }
  const planeBytes = osqCodeBytes(levels.length, documentBits)
  target.fill(0, 0, QUERY_PLANES_FOR_NARROW_CODES * planeBytes)
  if (documentBits === 2) {
    for (let i = 0; i < levels.length; i++) {
      target[(i % LEVELS_IN_A_TWO_BIT_BYTE) * planeBytes + Math.floor(i / LEVELS_IN_A_TWO_BIT_BYTE)] = levels[i]
    }
    return
  }
  for (let i = 0; i < levels.length; i++) {
    const value = levels[i]
    if (value === 0) continue
    const byte = i >> 3
    const bit = 1 << (i & 7)
    for (let plane = 0; plane < QUERY_PLANES_FOR_NARROW_CODES; plane++) {
      if ((value >> plane) & 1) target[plane * planeBytes + byte] |= bit
    }
  }
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
