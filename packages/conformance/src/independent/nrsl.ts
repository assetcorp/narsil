import { gunzipSync } from 'node:zlib'
import { crc32 } from './crc32'

export const NRSL_HEADER_BYTES = 32
const MAX_FILE_BYTES = 2_147_483_647
const NRSL_MAGIC = [0x4e, 0x52, 0x53, 0x4c]
const RESERVED_START = 18
const COMPRESSION_BIT = 0b1
const ALGORITHM_SHIFT = 1
const ALGORITHM_MASK = 0b11
const CHECKSUM_BIT = 0b1000
const ENCRYPTION_BIT = 0b1_0000
const GZIP_ALGORITHM = 0b01

export class NrslFormatError extends Error {}

export interface NrslFile {
  envelopeFormatVersion: number
  engineVersion: [number, number, number]
  flags: number
  compression: 'none' | 'gzip'
  checksumPresent: boolean
  checksum: number
  storedPayload: Uint8Array
  payload: Uint8Array
}

export function beginsWithNrsl(bytes: Uint8Array): boolean {
  return bytes.length >= NRSL_MAGIC.length && NRSL_MAGIC.every((byte, at) => bytes[at] === byte)
}

export function openNrsl(bytes: Uint8Array): NrslFile {
  if (bytes.length < NRSL_HEADER_BYTES)
    throw new NrslFormatError(`the file holds ${bytes.length} bytes, under a header`)
  if (!beginsWithNrsl(bytes)) throw new NrslFormatError('the file does not begin with NRSL')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const payloadLength = view.getUint32(8, false)
  const flags = view.getUint16(12, false)
  const checksum = view.getUint32(14, false)
  if (bytes.length - NRSL_HEADER_BYTES !== payloadLength) {
    throw new NrslFormatError(
      `the header gives a payload of ${payloadLength} bytes, while ${bytes.length - NRSL_HEADER_BYTES} follow it`,
    )
  }
  for (let at = RESERVED_START; at < NRSL_HEADER_BYTES; at++) {
    if (bytes[at] !== 0) throw new NrslFormatError(`reserved header byte ${at} holds ${bytes[at]}`)
  }
  if ((flags & ENCRYPTION_BIT) !== 0) throw new NrslFormatError('the header sets the encryption flag')
  const compressed = (flags & COMPRESSION_BIT) !== 0
  const algorithm = (flags >> ALGORITHM_SHIFT) & ALGORITHM_MASK
  if (compressed && algorithm !== GZIP_ALGORITHM) {
    throw new NrslFormatError(`the header names compression algorithm ${algorithm}`)
  }
  const checksumPresent = (flags & CHECKSUM_BIT) !== 0
  const storedPayload = bytes.subarray(NRSL_HEADER_BYTES)
  if (checksumPresent && crc32(storedPayload) !== checksum) {
    throw new NrslFormatError(`the payload checksum ${crc32(storedPayload)} differs from the header's ${checksum}`)
  }
  if (!checksumPresent && checksum !== 0) {
    throw new NrslFormatError('the header holds a checksum without the checksum flag')
  }
  return {
    envelopeFormatVersion: bytes[4],
    engineVersion: [bytes[5], bytes[6], bytes[7]],
    flags,
    compression: compressed ? 'gzip' : 'none',
    checksumPresent,
    checksum,
    storedPayload,
    payload: compressed
      ? new Uint8Array(gunzipSync(storedPayload, { maxOutputLength: MAX_FILE_BYTES }))
      : storedPayload,
  }
}
