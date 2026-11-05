import { type Decoded, DecodedTimestamp, FormError } from '../forms/decoded'
import { type Packed, unpackOne } from './msgpack'

const TIMESTAMP_EXTENSION = -1
const SECONDS_BITS = 34n
const THIRTY_FOUR_BITS = (1n << SECONDS_BITS) - 1n

function timestampOf(data: Uint8Array): DecodedTimestamp {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.byteLength === 4) return new DecodedTimestamp(view.getUint32(0, false), 0)
  if (data.byteLength === 8) {
    const packed = view.getBigUint64(0, false)
    return new DecodedTimestamp(Number(packed & THIRTY_FOUR_BITS), Number(packed >> SECONDS_BITS))
  }
  if (data.byteLength === 12) {
    const seconds = view.getBigInt64(4, false)
    if (seconds > BigInt(Number.MAX_SAFE_INTEGER) || seconds < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FormError(`a timestamp holds ${seconds} seconds, outside the range of a float64 integer`)
    }
    return new DecodedTimestamp(Number(seconds), view.getUint32(0, false))
  }
  throw new FormError(`a timestamp extension holds ${data.byteLength} bytes`)
}

function integerOf(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FormError(`an integer ${value} lies outside the range that a float64 holds exactly`)
  }
  return Number(value)
}

export function decodedOf(value: Packed): Decoded {
  switch (value.kind) {
    case 'nil':
      return null
    case 'boolean':
    case 'string':
    case 'binary':
      return value.value
    case 'float':
      return value.value
    case 'integer':
      return integerOf(value.value)
    case 'array':
      return value.items.map(decodedOf)
    case 'map': {
      const map = new Map<string, Decoded>()
      for (const [key, entry] of value.entries) {
        if (key.kind !== 'string') throw new FormError(`a map holds a ${key.kind} key`)
        if (map.has(key.value)) throw new FormError(`a map repeats the key ${key.value}`)
        map.set(key.value, decodedOf(entry))
      }
      return map
    }
    case 'extension':
      if (value.type !== TIMESTAMP_EXTENSION) throw new FormError(`a value holds extension type ${value.type}`)
      return timestampOf(value.data)
  }
}

export function unpackDecoded(bytes: Uint8Array): Decoded {
  return decodedOf(unpackOne(bytes))
}
