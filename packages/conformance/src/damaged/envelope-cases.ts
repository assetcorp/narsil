import { HEADER_SIZE } from '../../../ts/src/serialization/header'
import { type CaseBuild, damagedCheckpoint } from './build'
import { baseFile, CHECKSUM_OFFSET, FLAGS_OFFSET, PAYLOAD_LENGTH_OFFSET, withBytesAt } from './bytes'

const INDEX = 'products'
const META = 'meta'
const SEGMENT = 'segments/0/s0000000000000001'
const CHECKSUM_FLAG = 0x08
const LZ4_FLAGS = 0b101
const ZSTD_FLAGS = 0b111
const ENCRYPTION_FLAG = 0x10
const RESERVED_FLAG_BITS = 0xffe0
const RESERVED_START = 18

function withFlags(bytes: Uint8Array, flags: number): Uint8Array {
  return withBytesAt(bytes, FLAGS_OFFSET, [(flags >> 8) & 0xff, flags & 0xff])
}

function withPayloadLength(bytes: Uint8Array, length: number): Uint8Array {
  const copy = bytes.slice()
  new DataView(copy.buffer).setUint32(PAYLOAD_LENGTH_OFFSET, length, false)
  return copy
}

export async function envelopeCases(): Promise<CaseBuild[]> {
  const meta = await baseFile(INDEX, META)
  const segment = await baseFile(INDEX, SEGMENT)
  const payloadByte = HEADER_SIZE + Math.floor((meta.byteLength - HEADER_SIZE) / 2)
  const rule = (anchor: string) => `envelope.md#${anchor}`
  return [
    damagedCheckpoint('envelope-magic', rule('magic-bytes'), 'ENVELOPE_INVALID_MAGIC', INDEX, {
      [META]: withBytesAt(meta, 0, [0x4e, 0x52, 0x53, 0x58]),
    }),
    damagedCheckpoint('envelope-shorter-than-header', rule('magic-bytes'), 'ENVELOPE_INVALID_MAGIC', INDEX, {
      [META]: meta.slice(0, HEADER_SIZE - 1),
    }),
    damagedCheckpoint('envelope-lz4', rule('compression'), 'ENVELOPE_VERSION_MISMATCH', INDEX, {
      [META]: withFlags(meta, LZ4_FLAGS | CHECKSUM_FLAG),
    }),
    damagedCheckpoint('envelope-zstd', rule('compression'), 'ENVELOPE_VERSION_MISMATCH', INDEX, {
      [META]: withFlags(meta, ZSTD_FLAGS | CHECKSUM_FLAG),
    }),
    damagedCheckpoint('envelope-encrypted', rule('encryption'), 'ENVELOPE_VERSION_MISMATCH', INDEX, {
      [META]: withFlags(meta, ENCRYPTION_FLAG | CHECKSUM_FLAG),
    }),
    damagedCheckpoint('envelope-payload-past-end', rule('payload-length'), 'PERSISTENCE_LOAD_FAILED', INDEX, {
      [META]: withPayloadLength(meta, meta.byteLength - HEADER_SIZE + 1),
    }),
    damagedCheckpoint('envelope-checksum', rule('checksum'), 'PERSISTENCE_CRC_MISMATCH', INDEX, {
      [META]: withBytesAt(meta, payloadByte, [(meta[payloadByte] ?? 0) ^ 0x01]),
    }),
    damagedCheckpoint('envelope-reserved-bytes-and-flags', rule('reserved-bytes'), null, INDEX, {
      [META]: withBytesAt(withFlags(meta, RESERVED_FLAG_BITS | CHECKSUM_FLAG), RESERVED_START, [1, 2, 3, 4]),
      [SEGMENT]: withBytesAt(withFlags(segment, RESERVED_FLAG_BITS | CHECKSUM_FLAG), RESERVED_START + 10, [0xff]),
    }),
    damagedCheckpoint('envelope-no-checksum', rule('checksum'), null, INDEX, {
      [META]: withBytesAt(withFlags(meta, 0), CHECKSUM_OFFSET, [0, 0, 0, 0]),
    }),
  ]
}
