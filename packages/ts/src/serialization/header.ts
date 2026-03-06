import { ErrorCodes, NarsilError } from '../errors'

const MAGIC_BYTES = new Uint8Array([0x4e, 0x52, 0x53, 0x4c])
const HEADER_SIZE = 32
const RESERVED_SIZE = 14

export interface NrslFlags {
  compressionEnabled: boolean
  compressionAlgorithm: 'none' | 'gzip' | 'lz4' | 'zstd'
  checksumPresent: boolean
  encryptionEnabled: boolean
}

export interface NrslHeader {
  magic: 'NRSL'
  envelopeFormatVersion: number
  engineVersionMajor: number
  engineVersionMinor: number
  engineVersionPatch: number
  payloadLength: number
  flags: NrslFlags
  checksum: number
  reserved: Uint8Array
}

const COMPRESSION_ALGORITHMS: Record<number, NrslFlags['compressionAlgorithm']> = {
  0: 'none',
  1: 'gzip',
  2: 'lz4',
  3: 'zstd',
}

const COMPRESSION_TO_BITS: Record<string, number> = {
  none: 0b00,
  gzip: 0b01,
  lz4: 0b10,
  zstd: 0b11,
}

export function encodeFlags(flags: NrslFlags): number {
  let bits = 0
  if (flags.compressionEnabled) bits |= 1
  bits |= (COMPRESSION_TO_BITS[flags.compressionAlgorithm] & 0b11) << 1
  if (flags.checksumPresent) bits |= 1 << 3
  if (flags.encryptionEnabled) bits |= 1 << 4
  return bits
}

export function decodeFlags(value: number): NrslFlags {
  const compressionEnabled = (value & 1) === 1
  const algorithmBits = (value >> 1) & 0b11
  const checksumPresent = ((value >> 3) & 1) === 1
  const encryptionEnabled = ((value >> 4) & 1) === 1

  return {
    compressionEnabled,
    compressionAlgorithm: COMPRESSION_ALGORITHMS[algorithmBits] ?? 'none',
    checksumPresent,
    encryptionEnabled,
  }
}

export function writeHeader(header: NrslHeader): Uint8Array {
  const buffer = new Uint8Array(HEADER_SIZE)
  const view = new DataView(buffer.buffer)

  buffer.set(MAGIC_BYTES, 0)
  buffer[4] = header.envelopeFormatVersion & 0xff
  buffer[5] = header.engineVersionMajor & 0xff
  buffer[6] = header.engineVersionMinor & 0xff
  buffer[7] = header.engineVersionPatch & 0xff
  view.setUint32(8, header.payloadLength, false)
  view.setUint16(12, encodeFlags(header.flags), false)
  view.setUint32(14, header.checksum, false)

  for (let i = 18; i < HEADER_SIZE; i++) {
    buffer[i] = 0x00
  }

  return buffer
}

export function readHeader(data: Uint8Array): NrslHeader {
  if (data.length < HEADER_SIZE) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_INVALID_MAGIC,
      `Expected at least ${HEADER_SIZE} bytes, received ${data.length}`,
    )
  }

  if (
    data[0] !== MAGIC_BYTES[0] ||
    data[1] !== MAGIC_BYTES[1] ||
    data[2] !== MAGIC_BYTES[2] ||
    data[3] !== MAGIC_BYTES[3]
  ) {
    throw new NarsilError(ErrorCodes.ENVELOPE_INVALID_MAGIC, 'File does not begin with NRSL magic bytes')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const envelopeFormatVersion = data[4]
  const engineVersionMajor = data[5]
  const engineVersionMinor = data[6]
  const engineVersionPatch = data[7]
  const payloadLength = view.getUint32(8, false)
  const flagBits = view.getUint16(12, false)
  const checksum = view.getUint32(14, false)
  const reserved = data.slice(18, HEADER_SIZE)

  return {
    magic: 'NRSL',
    envelopeFormatVersion,
    engineVersionMajor,
    engineVersionMinor,
    engineVersionPatch,
    payloadLength,
    flags: decodeFlags(flagBits),
    checksum,
    reserved,
  }
}

export { HEADER_SIZE, RESERVED_SIZE }
