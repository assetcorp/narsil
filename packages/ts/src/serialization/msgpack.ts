import { ExtensionCodec, Decoder as MessagePackDecoder } from '@msgpack/msgpack'
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

function stringRegions(
  bytes: Uint8Array,
  start: number,
): { strings: Map<number, number>; end: number; affected: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const strings = new Map<number, number>()
  let at = start
  let pending = 1
  let affected = false
  while (pending > 0) {
    const header = headerAt(view, at)
    if (header === null) throw new RangeError('Invalid MessagePack value header')
    const tag = bytes[at]
    at += header.headerBytes
    if ((tag >= 0xa0 && tag <= 0xbf) || tag === 0xd9 || tag === 0xda || tag === 0xdb) {
      strings.set(bytes.byteOffset + at, header.bodyBytes)
      if (header.bodyBytes >= 3 && bytes[at] === 0xef && bytes[at + 1] === 0xbb && bytes[at + 2] === 0xbf)
        affected = true
    }
    at += header.bodyBytes
    pending += header.children - 1
    if (at > bytes.length || pending > bytes.length - at) throw new RangeError('Incomplete MessagePack value')
  }
  return { strings, end: at, affected }
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
    if (!mayHoldByteOrderMark(bytes)) return this.ordinary.decode(bytes)
    const { strings, end, affected } = stringRegions(bytes, 0)
    if (end !== bytes.length) throw new RangeError('Extra bytes after a MessagePack value')
    if (!affected) return this.ordinary.decode(bytes)
    const { decoder, extensions } = losslessDecoder()
    return restoreStrings(decoder.decode(bytes), bytes, strings, extensions)
  }

  *decodeMulti(bytes: Uint8Array): Generator<unknown, void, unknown> {
    if (!mayHoldByteOrderMark(bytes)) {
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

export function decode(bytes: Uint8Array): unknown {
  return new Decoder().decode(bytes)
}

export function decodeMulti(bytes: Uint8Array): Generator<unknown, void, unknown> {
  return new Decoder().decodeMulti(bytes)
}
