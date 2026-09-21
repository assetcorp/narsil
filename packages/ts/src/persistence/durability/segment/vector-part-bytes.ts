import { encode } from '@msgpack/msgpack'

const EMPTY_BIN = new Uint8Array(0)
const EMPTY_BIN_BYTES = 2
const BIN8 = 0xc4
const BIN16 = 0xc5
const BIN32 = 0xc6
const BIN8_MAX_BYTES = 0xff
const BIN16_MAX_BYTES = 0xffff

function binHeader(byteLength: number): Uint8Array {
  if (byteLength <= BIN8_MAX_BYTES) return Uint8Array.of(BIN8, byteLength)
  if (byteLength <= BIN16_MAX_BYTES) return Uint8Array.of(BIN16, byteLength >> 8, byteLength & 0xff)
  const header = new Uint8Array(5)
  header[0] = BIN32
  new DataView(header.buffer).setUint32(1, byteLength, false)
  return header
}

export function chunksEndingInBytes(
  withTheBytes: unknown,
  withEmptyBytesInTheirPlace: unknown,
  bytes: Uint8Array,
): Uint8Array[] {
  const head = encode(withEmptyBytesInTheirPlace)
  const endsWithTheEmptyBin = head[head.length - EMPTY_BIN_BYTES] === BIN8 && head[head.length - 1] === 0
  if (!endsWithTheEmptyBin) return [encode(withTheBytes)]
  return [head.subarray(0, head.length - EMPTY_BIN_BYTES), binHeader(bytes.byteLength), bytes]
}

export function vectorPartChunks<Part extends { vectors: Uint8Array }>(part: Part): Uint8Array[] {
  return chunksEndingInBytes(part, { ...part, vectors: EMPTY_BIN }, part.vectors)
}
