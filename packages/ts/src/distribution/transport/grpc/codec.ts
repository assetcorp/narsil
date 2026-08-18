import { TransportError, TransportErrorCodes } from '../types'

const FIELD_ONE_LENGTH_DELIMITED_KEY = 0x0a
const WIRE_TYPE_VARINT = 0
const WIRE_TYPE_FIXED64 = 1
const WIRE_TYPE_LENGTH_DELIMITED = 2
const WIRE_TYPE_FIXED32 = 5
const MAX_VARINT_BYTES = 5

interface VarintRead {
  value: number
  next: number
}

function decodeError(reason: string): TransportError {
  return new TransportError(TransportErrorCodes.DECODE_FAILED, `Failed to decode a protobuf envelope: ${reason}`)
}

function readVarint(data: Uint8Array, pos: number): VarintRead {
  let value = 0
  let factor = 1
  for (let index = 0; index < MAX_VARINT_BYTES; index++) {
    if (pos + index >= data.byteLength) {
      throw decodeError('a varint runs past the end of the buffer')
    }
    const byte = data[pos + index]
    value += (byte & 0x7f) * factor
    if ((byte & 0x80) === 0) {
      return { value, next: pos + index + 1 }
    }
    factor *= 128
  }
  throw decodeError('a varint exceeds five bytes')
}

export function encodeBytesMessage(data: Uint8Array): Buffer {
  const header: number[] = [FIELD_ONE_LENGTH_DELIMITED_KEY]
  let remaining = data.byteLength
  while (remaining > 0x7f) {
    header.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  header.push(remaining)

  const out = Buffer.allocUnsafe(header.length + data.byteLength)
  out.set(header, 0)
  out.set(data, header.length)
  return out
}

export function decodeBytesMessage(data: Uint8Array): Uint8Array {
  let pos = 0
  let field: Uint8Array | null = null

  while (pos < data.byteLength) {
    const key = readVarint(data, pos)
    pos = key.next
    const fieldNumber = Math.floor(key.value / 8)
    const wireType = key.value % 8

    if (fieldNumber === 0) {
      throw decodeError('field number zero is invalid')
    }

    if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      const length = readVarint(data, pos)
      pos = length.next
      if (length.value > data.byteLength - pos) {
        throw decodeError('a length-delimited field runs past the end of the buffer')
      }
      const end = pos + length.value
      if (fieldNumber === 1) {
        field = data.subarray(pos, end)
      }
      pos = end
    } else if (wireType === WIRE_TYPE_VARINT) {
      pos = readVarint(data, pos).next
    } else if (wireType === WIRE_TYPE_FIXED64) {
      if (data.byteLength - pos < 8) {
        throw decodeError('a fixed64 field runs past the end of the buffer')
      }
      pos += 8
    } else if (wireType === WIRE_TYPE_FIXED32) {
      if (data.byteLength - pos < 4) {
        throw decodeError('a fixed32 field runs past the end of the buffer')
      }
      pos += 4
    } else {
      throw decodeError(`wire type ${wireType} is unsupported`)
    }
  }

  return field ?? new Uint8Array(0)
}
