import { ExtensionCodec, Decoder as MessagePackDecoder } from '@msgpack/msgpack'
import { BYTE_ORDER_MARK_WALK_BYTES_PER_HEADER } from '#platform/msgpack-host'
import { headerAt } from './msgpack-header'

const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
const keyDecoder = {
  canBeCached: () => true,
  decode: (bytes: Uint8Array, offset: number, length: number) =>
    textDecoder.decode(bytes.subarray(offset, offset + length)),
}

function mayHoldByteOrderMark(bytes: Uint8Array): boolean {
  for (let at = bytes.indexOf(0xef); at >= 0; at = bytes.indexOf(0xef, at + 1)) {
    if (bytes[at + 1] === 0xbb && bytes[at + 2] === 0xbf) return true
  }
  return false
}

interface StringScan {
  end: number
  affected: boolean
  headers: number
}

function scanStrings(
  bytes: Uint8Array,
  start: number,
  strings: Map<number, number> | null,
  headerLimit: number,
): StringScan | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = start
  let pending = 1
  let affected = false
  let headers = 0
  while (pending > 0) {
    if (headers >= headerLimit) return null
    headers += 1
    const header = headerAt(view, at)
    if (header === null) throw new RangeError('Invalid MessagePack value header')
    const tag = bytes[at]
    at += header.headerBytes
    if ((tag >= 0xa0 && tag <= 0xbf) || tag === 0xd9 || tag === 0xda || tag === 0xdb) {
      strings?.set(bytes.byteOffset + at, header.bodyBytes)
      if (header.bodyBytes >= 3 && bytes[at] === 0xef && bytes[at + 1] === 0xbb && bytes[at + 2] === 0xbf)
        affected = true
    }
    at += header.bodyBytes
    pending += header.children - 1
    if (at > bytes.length || pending > bytes.length - at) throw new RangeError('Incomplete MessagePack value')
  }
  return { end: at, affected, headers }
}

function stringRegions(
  bytes: Uint8Array,
  start: number,
): { strings: Map<number, number>; end: number; affected: boolean } {
  const strings = new Map<number, number>()
  const scan = scanStrings(bytes, start, strings, Number.POSITIVE_INFINITY)
  if (scan === null) throw new RangeError('Invalid MessagePack value header')
  return { strings, end: scan.end, affected: scan.affected }
}

function holdsOnlyPlainStrings(bytes: Uint8Array, holdsOneValue: boolean): boolean {
  let remaining = Math.ceil(bytes.length / BYTE_ORDER_MARK_WALK_BYTES_PER_HEADER)
  let at = 0
  try {
    while (at < bytes.length) {
      const scan = scanStrings(bytes, at, null, remaining)
      if (scan === null || scan.affected) return false
      if (holdsOneValue) return scan.end === bytes.length
      remaining -= scan.headers
      at = scan.end
    }
    return !holdsOneValue
  } catch {
    return false
  }
}

function restoreStrings(
  value: unknown,
  bytes: Uint8Array,
  strings: ReadonlyMap<number, number>,
  extensions: WeakSet<object>,
): unknown {
  const pending: Array<unknown[] | Record<string, unknown>> = []
  function convert(entry: unknown): unknown {
    if (entry !== null && typeof entry === 'object' && extensions.has(entry)) return entry
    if (entry instanceof Uint8Array) {
      return entry.buffer === bytes.buffer && strings.get(entry.byteOffset) === entry.byteLength
        ? textDecoder.decode(entry)
        : entry
    }
    if (Array.isArray(entry)) pending.push(entry)
    else if (entry !== null && typeof entry === 'object' && Object.getPrototypeOf(entry) === Object.prototype)
      pending.push(entry as Record<string, unknown>)
    return entry
  }
  const result = convert(value)
  while (pending.length > 0) {
    const container = pending.pop()
    if (container === undefined) break
    if (Array.isArray(container)) {
      for (let at = 0; at < container.length; at++) container[at] = convert(container[at])
    } else {
      for (const key of Object.keys(container)) container[key] = convert(container[key])
    }
  }
  return result
}

function losslessDecoder(): { decoder: MessagePackDecoder; extensions: WeakSet<object> } {
  const extensions = new WeakSet<object>()
  const extensionCodec = {
    tryToEncode: ExtensionCodec.defaultCodec.tryToEncode.bind(ExtensionCodec.defaultCodec),
    decode(data: Uint8Array, type: number): unknown {
      const value = ExtensionCodec.defaultCodec.decode(data, type, undefined)
      if (value !== null && typeof value === 'object') extensions.add(value)
      return value
    },
  }
  return { decoder: new MessagePackDecoder({ rawStrings: true, keyDecoder, extensionCodec }), extensions }
}

export class Decoder {
  private readonly ordinary = new MessagePackDecoder()

  decode(bytes: Uint8Array): unknown {
    if (!mayHoldByteOrderMark(bytes) || holdsOnlyPlainStrings(bytes, true)) return this.ordinary.decode(bytes)
    const { strings, end, affected } = stringRegions(bytes, 0)
    if (end !== bytes.length) throw new RangeError('Extra bytes after a MessagePack value')
    if (!affected) return this.ordinary.decode(bytes)
    const { decoder, extensions } = losslessDecoder()
    return restoreStrings(decoder.decode(bytes), bytes, strings, extensions)
  }

  *decodeMulti(bytes: Uint8Array): Generator<unknown, void, unknown> {
    if (!mayHoldByteOrderMark(bytes) || holdsOnlyPlainStrings(bytes, false)) {
      yield* this.ordinary.decodeMulti(bytes)
      return
    }
    let at = 0
    const { decoder, extensions } = losslessDecoder()
    while (at < bytes.length) {
      const { strings, end, affected } = stringRegions(bytes, at)
      const value = (affected ? decoder : this.ordinary).decode(bytes.subarray(at, end))
      at = end
      yield affected ? restoreStrings(value, bytes, strings, extensions) : value
    }
  }
}

let sharedDecoder: Decoder | null = null

export function decode(bytes: Uint8Array): unknown {
  sharedDecoder ??= new Decoder()
  return sharedDecoder.decode(bytes)
}

export function decodeMulti(bytes: Uint8Array): Generator<unknown, void, unknown> {
  return new Decoder().decodeMulti(bytes)
}
