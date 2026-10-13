import { encode } from '@msgpack/msgpack'

const FIXMAP = 0x80
const MAP16 = 0xde
const MAP32 = 0xdf
const FIXARRAY = 0x90
const ARRAY16 = 0xdc
const ARRAY32 = 0xdd
const BIN8 = 0xc4
const BIN16 = 0xc5
const BIN32 = 0xc6
const FIX_COUNT_LIMIT = 16
const UINT8_LIMIT = 0x100
const UINT16_LIMIT = 0x10000

function header(fixed: number, sixteen: number, thirtyTwo: number, count: number): Uint8Array {
  if (count < FIX_COUNT_LIMIT) return Uint8Array.of(fixed | count)
  if (count < UINT16_LIMIT) return Uint8Array.of(sixteen, count >> 8, count & 0xff)
  const bytes = new Uint8Array(5)
  bytes[0] = thirtyTwo
  new DataView(bytes.buffer).setUint32(1, count, false)
  return bytes
}

function binHeader(byteLength: number): Uint8Array {
  if (byteLength < UINT8_LIMIT) return Uint8Array.of(BIN8, byteLength)
  if (byteLength < UINT16_LIMIT) return Uint8Array.of(BIN16, byteLength >> 8, byteLength & 0xff)
  const bytes = new Uint8Array(5)
  bytes[0] = BIN32
  new DataView(bytes.buffer).setUint32(1, byteLength, false)
  return bytes
}

export class MessagePackChunks {
  readonly chunks: Uint8Array[] = []
  byteLength = 0

  private push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.chunks.push(chunk)
    this.byteLength += chunk.byteLength
  }

  map(entries: number): this {
    this.push(header(FIXMAP, MAP16, MAP32, entries))
    return this
  }

  array(items: number): this {
    this.push(header(FIXARRAY, ARRAY16, ARRAY32, items))
    return this
  }

  value(value: unknown): this {
    this.push(encode(value))
    return this
  }

  key(name: string): this {
    return this.value(name)
  }

  binary(bytes: Uint8Array): this {
    this.push(binHeader(bytes.byteLength))
    this.push(bytes)
    return this
  }

  binaryOrNil(bytes: Uint8Array | null): this {
    return bytes === null ? this.value(null) : this.binary(bytes)
  }
}
