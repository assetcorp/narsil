export type Packed =
  | { kind: 'nil' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer'; value: bigint }
  | { kind: 'float'; width: 32 | 64; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'binary'; value: Uint8Array }
  | { kind: 'array'; items: Packed[] }
  | { kind: 'map'; entries: Array<[Packed, Packed]> }
  | { kind: 'extension'; type: number; data: Uint8Array }

const MAX_NESTING_DEPTH = 512
const utf8 = new TextDecoder('utf-8', { fatal: true })

export class PackedFormatError extends Error {}

class Cursor {
  readonly view: DataView
  at = 0

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  need(count: number): void {
    if (count > this.bytes.length - this.at) {
      throw new PackedFormatError(`MessagePack ends inside a value at byte ${this.at}`)
    }
  }

  uint8(): number {
    this.need(1)
    const value = this.bytes[this.at]
    this.at += 1
    return value
  }

  uint16(): number {
    this.need(2)
    const value = this.view.getUint16(this.at, false)
    this.at += 2
    return value
  }

  uint32(): number {
    this.need(4)
    const value = this.view.getUint32(this.at, false)
    this.at += 4
    return value
  }

  take(count: number): Uint8Array {
    this.need(count)
    const slice = this.bytes.slice(this.at, this.at + count)
    this.at += count
    return slice
  }
}

function integerOf(cursor: Cursor, width: 1 | 2 | 4 | 8, signed: boolean): Packed {
  cursor.need(width)
  const { view, at } = cursor
  cursor.at += width
  if (width === 1) return { kind: 'integer', value: BigInt(signed ? view.getInt8(at) : view.getUint8(at)) }
  if (width === 2) return { kind: 'integer', value: BigInt(signed ? view.getInt16(at) : view.getUint16(at)) }
  if (width === 4) return { kind: 'integer', value: BigInt(signed ? view.getInt32(at) : view.getUint32(at)) }
  return { kind: 'integer', value: signed ? view.getBigInt64(at) : view.getBigUint64(at) }
}

function stringOf(cursor: Cursor, length: number): Packed {
  const bytes = cursor.take(length)
  try {
    return { kind: 'string', value: utf8.decode(bytes) }
  } catch {
    throw new PackedFormatError(`a MessagePack string before byte ${cursor.at} is not valid UTF-8`)
  }
}

function arrayOf(cursor: Cursor, count: number, depth: number): Packed {
  cursor.need(count)
  const items: Packed[] = []
  for (let at = 0; at < count; at++) items.push(valueAt(cursor, depth + 1))
  return { kind: 'array', items }
}

function mapOf(cursor: Cursor, count: number, depth: number): Packed {
  cursor.need(count * 2)
  const entries: Array<[Packed, Packed]> = []
  for (let at = 0; at < count; at++) {
    const key = valueAt(cursor, depth + 1)
    entries.push([key, valueAt(cursor, depth + 1)])
  }
  return { kind: 'map', entries }
}

function extensionOf(cursor: Cursor, length: number): Packed {
  cursor.need(1)
  const type = cursor.view.getInt8(cursor.at)
  cursor.at += 1
  return { kind: 'extension', type, data: cursor.take(length) }
}

function floatOf(cursor: Cursor, width: 32 | 64): Packed {
  const bytes = width / 8
  cursor.need(bytes)
  const value = width === 32 ? cursor.view.getFloat32(cursor.at, false) : cursor.view.getFloat64(cursor.at, false)
  cursor.at += bytes
  return { kind: 'float', width, value }
}

function valueAt(cursor: Cursor, depth: number): Packed {
  if (depth > MAX_NESTING_DEPTH) throw new PackedFormatError(`MessagePack nests deeper than ${MAX_NESTING_DEPTH}`)
  const lead = cursor.uint8()
  if (lead <= 0x7f) return { kind: 'integer', value: BigInt(lead) }
  if (lead >= 0xe0) return { kind: 'integer', value: BigInt(lead - 0x100) }
  if ((lead & 0xf0) === 0x80) return mapOf(cursor, lead & 0x0f, depth)
  if ((lead & 0xf0) === 0x90) return arrayOf(cursor, lead & 0x0f, depth)
  if ((lead & 0xe0) === 0xa0) return stringOf(cursor, lead & 0x1f)
  switch (lead) {
    case 0xc0:
      return { kind: 'nil' }
    case 0xc2:
      return { kind: 'boolean', value: false }
    case 0xc3:
      return { kind: 'boolean', value: true }
    case 0xc4:
      return { kind: 'binary', value: cursor.take(cursor.uint8()) }
    case 0xc5:
      return { kind: 'binary', value: cursor.take(cursor.uint16()) }
    case 0xc6:
      return { kind: 'binary', value: cursor.take(cursor.uint32()) }
    case 0xc7:
      return extensionOf(cursor, cursor.uint8())
    case 0xc8:
      return extensionOf(cursor, cursor.uint16())
    case 0xc9:
      return extensionOf(cursor, cursor.uint32())
    case 0xca:
      return floatOf(cursor, 32)
    case 0xcb:
      return floatOf(cursor, 64)
    case 0xcc:
      return integerOf(cursor, 1, false)
    case 0xcd:
      return integerOf(cursor, 2, false)
    case 0xce:
      return integerOf(cursor, 4, false)
    case 0xcf:
      return integerOf(cursor, 8, false)
    case 0xd0:
      return integerOf(cursor, 1, true)
    case 0xd1:
      return integerOf(cursor, 2, true)
    case 0xd2:
      return integerOf(cursor, 4, true)
    case 0xd3:
      return integerOf(cursor, 8, true)
    case 0xd4:
      return extensionOf(cursor, 1)
    case 0xd5:
      return extensionOf(cursor, 2)
    case 0xd6:
      return extensionOf(cursor, 4)
    case 0xd7:
      return extensionOf(cursor, 8)
    case 0xd8:
      return extensionOf(cursor, 16)
    case 0xd9:
      return stringOf(cursor, cursor.uint8())
    case 0xda:
      return stringOf(cursor, cursor.uint16())
    case 0xdb:
      return stringOf(cursor, cursor.uint32())
    case 0xdc:
      return arrayOf(cursor, cursor.uint16(), depth)
    case 0xdd:
      return arrayOf(cursor, cursor.uint32(), depth)
    case 0xde:
      return mapOf(cursor, cursor.uint16(), depth)
    case 0xdf:
      return mapOf(cursor, cursor.uint32(), depth)
    default:
      throw new PackedFormatError(`byte 0x${lead.toString(16)} at ${cursor.at - 1} starts no MessagePack value`)
  }
}

export function unpackOne(bytes: Uint8Array): Packed {
  const cursor = new Cursor(bytes)
  const value = valueAt(cursor, 0)
  if (cursor.at !== bytes.length) {
    throw new PackedFormatError(`${bytes.length - cursor.at} bytes follow the MessagePack value`)
  }
  return value
}

export function unpackPrefix(bytes: Uint8Array): { value: Packed; length: number } {
  const cursor = new Cursor(bytes)
  const value = valueAt(cursor, 0)
  return { value, length: cursor.at }
}

export function fieldsOf(value: Packed, what: string): Map<string, Packed> {
  if (value.kind !== 'map') throw new PackedFormatError(`${what} is a MessagePack ${value.kind}, not a map`)
  const fields = new Map<string, Packed>()
  for (const [key, entry] of value.entries) {
    if (key.kind !== 'string') throw new PackedFormatError(`${what} holds a key that is not a string`)
    if (fields.has(key.value)) throw new PackedFormatError(`${what} repeats the key "${key.value}"`)
    fields.set(key.value, entry)
  }
  return fields
}
