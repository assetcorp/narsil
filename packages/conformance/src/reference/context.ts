import { decode, decodeMulti, decodeTimestampToTimeSpec, EXT_TIMESTAMP, ExtensionCodec } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../ts/src/errors'
import { crc32 } from '../../../ts/src/serialization/crc32'
import { encodeDocument } from '../../../ts/src/serialization/document-encoding'
import { gunzip } from '../../../ts/src/serialization/gzip'
import { HEADER_SIZE, readHeader } from '../../../ts/src/serialization/header'
import type { FormContext, OpenedEnvelope } from '../forms/codec'
import { type Decoded, DecodedTimestamp, FormError } from '../forms/decoded'

const MILLISECONDS_PER_SECOND = 1_000
const NANOSECONDS_PER_MILLISECOND = 1_000_000

const timestampCodec = new ExtensionCodec()
timestampCodec.register({
  type: EXT_TIMESTAMP,
  encode: () => null,
  decode: data => {
    const { sec, nsec } = decodeTimestampToTimeSpec(data)
    return new DecodedTimestamp(sec, nsec)
  },
})

export function decodedOfReference(value: unknown, what: string): Decoded {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return value
  if (value instanceof Uint8Array || value instanceof DecodedTimestamp) return value
  if (Array.isArray(value)) return value.map((item, at) => decodedOfReference(item, `${what}[${at}]`))
  if (typeof value === 'object') {
    const map = new Map<string, Decoded>()
    for (const [key, entry] of Object.entries(value)) map.set(key, decodedOfReference(entry, `${what}.${key}`))
    return map
  }
  throw new FormError(`${what} decodes to a ${typeof value}`)
}

export function plainOf(value: Decoded, what: string): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value
  if (value instanceof DecodedTimestamp) {
    if (value.nanoseconds % NANOSECONDS_PER_MILLISECOND !== 0) {
      throw new FormError(`${what} holds a timestamp finer than the millisecond that the reference stores`)
    }
    return new Date(value.seconds * MILLISECONDS_PER_SECOND + value.nanoseconds / NANOSECONDS_PER_MILLISECOND)
  }
  if (Array.isArray(value)) return value.map((item, at) => plainOf(item, `${what}[${at}]`))
  return Object.fromEntries([...value].map(([key, entry]) => [key, plainOf(entry, `${what}.${key}`)]))
}

export function unpackReference(bytes: Uint8Array, what: string): Decoded {
  return decodedOfReference(decode(bytes, { extensionCodec: timestampCodec }), what)
}

async function openEnvelope(bytes: Uint8Array, what: string): Promise<OpenedEnvelope> {
  const header = readHeader(bytes)
  if (bytes.byteLength !== HEADER_SIZE + header.payloadLength) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `${what} holds a payload of the wrong length`)
  }
  const stored = bytes.subarray(HEADER_SIZE)
  if (header.flags.checksumPresent && crc32(stored) !== header.checksum) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_CRC_MISMATCH, `${what} fails its checksum`)
  }
  if (header.flags.encryptionEnabled) throw new FormError(`${what} is encrypted`)
  const gzip = header.flags.compressionEnabled
  if (gzip && header.flags.compressionAlgorithm !== 'gzip') throw new FormError(`${what} names another compression`)
  return {
    header: {
      envelopeFormatVersion: header.envelopeFormatVersion,
      compression: gzip ? 'gzip' : 'none',
      checksum: header.flags.checksumPresent,
    },
    payload: gzip ? await gunzip(stored) : stored,
  }
}

export const referenceContext: FormContext = {
  openEnvelope,
  unpack: unpackReference,
  unpackSequence: (bytes, what) =>
    Array.from(decodeMulti(bytes, { extensionCodec: timestampCodec }), (value, at) =>
      decodedOfReference(value, `${what}[${at}]`),
    ),
  pack: (value, what) => encodeDocument(plainOf(value, what)),
  crc32,
}
