import { Decoder, PROTOTYPE_POLLUTION_KEYS } from '#platform/segment-codec-host'
import { endOfValue, headerAt, type ValueHeader } from './msgpack-without-fields'

export interface EncodedPathRead {
  found: boolean
  value: unknown
}

export type EncodedArrayStep = 'decode-document' | 'missing'

const encoder = new TextEncoder()
const PROTO_KEY_BYTES = encoder.encode('__proto__')
const MISSING: EncodedPathRead = { found: false, value: undefined }
const foundRead: EncodedPathRead = { found: true, value: undefined }
const mapHeader: ValueHeader = { headerBytes: 0, bodyBytes: 0, children: 0 }
const keyHeader: ValueHeader = { headerBytes: 0, bodyBytes: 0, children: 0 }
let pathDecoder: Decoder | null = null

export function encodePathSegments(segments: readonly string[]): Uint8Array[] | null {
  if (segments.length === 0) return null
  if (segments.some(segment => PROTOTYPE_POLLUTION_KEYS.has(segment))) return null
  return segments.map(segment => encoder.encode(segment))
}

function isStringTag(tag: number): boolean {
  return (tag >= 0xa0 && tag <= 0xbf) || tag === 0xd9 || tag === 0xda || tag === 0xdb
}

function isMapTag(tag: number): boolean {
  return (tag >= 0x80 && tag <= 0x8f) || tag === 0xde || tag === 0xdf
}

function isArrayTag(tag: number): boolean {
  return (tag >= 0x90 && tag <= 0x9f) || tag === 0xdc || tag === 0xdd
}

function isScalarTag(tag: number): boolean {
  if (tag <= 0x7f || tag >= 0xe0 || isStringTag(tag)) return true
  return tag === 0xc0 || tag === 0xc2 || tag === 0xc3 || (tag >= 0xca && tag <= 0xd3)
}

function sameBytes(bytes: Uint8Array, start: number, end: number, target: Uint8Array): boolean {
  if (end - start !== target.length) return false
  for (let at = 0; at < target.length; at++) {
    if (bytes[start + at] !== target[at]) return false
  }
  return true
}

function keyEndAt(view: DataView, offset: number): number {
  if (!isStringTag(view.getUint8(offset))) return -1
  if (headerAt(view, offset, keyHeader) === null) return -1
  return offset + keyHeader.headerBytes + keyHeader.bodyBytes
}

export function readEncodedPath(
  bytes: Uint8Array,
  segments: readonly Uint8Array[],
  arrays: EncodedArrayStep,
): EncodedPathRead | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let start = 0
  let end = bytes.length
  for (let depth = 0; depth < segments.length; depth++) {
    if (start >= end) return null
    const tag = view.getUint8(start)
    if (!isMapTag(tag)) {
      if (depth === 0) return null
      if (isArrayTag(tag)) return arrays === 'missing' ? MISSING : null
      return isScalarTag(tag) ? MISSING : null
    }
    if (headerAt(view, start, mapHeader) === null) return null
    const pairs = mapHeader.children / 2
    let offset = start + mapHeader.headerBytes
    let valueStart = -1
    let valueEnd = -1
    for (let pair = 0; pair < pairs; pair++) {
      if (offset >= end) return null
      const keyEnd = keyEndAt(view, offset)
      if (keyEnd < 0 || keyEnd > end) return null
      const keyStart = offset + keyHeader.headerBytes
      if (sameBytes(bytes, keyStart, keyEnd, PROTO_KEY_BYTES)) return null
      const next = endOfValue(view, keyEnd)
      if (next === null || next > end) return null
      if (sameBytes(bytes, keyStart, keyEnd, segments[depth])) {
        valueStart = keyEnd
        valueEnd = next
      }
      offset = next
    }
    if (offset !== end) return null
    if (valueStart < 0) return MISSING
    start = valueStart
    end = valueEnd
  }
  try {
    pathDecoder ??= new Decoder()
    foundRead.value = pathDecoder.decode(bytes.subarray(start, end))
    return foundRead
  } catch {
    return null
  }
}
