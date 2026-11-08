import { decode } from './msgpack'
import { headerAt, MAP_TAGS } from './msgpack-header'

export { headerAt, type ValueHeader } from './msgpack-header'

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const keyDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function endOfValue(view: DataView, start: number): number | null {
  let offset = start
  let pending = 1
  while (pending > 0) {
    const header = headerAt(view, offset)
    if (header === null) return null
    offset += header.headerBytes + header.bodyBytes
    if (offset > view.byteLength) return null
    pending += header.children - 1
  }
  return offset
}

function stringKeyAt(bytes: Uint8Array, view: DataView, offset: number): { key: string; end: number } | null {
  const header = headerAt(view, offset)
  if (header === null || header.children !== 0) return null
  const tag = view.getUint8(offset)
  const isString = (tag >= 0xa0 && tag <= 0xbf) || tag === 0xd9 || tag === 0xda || tag === 0xdb
  const end = offset + header.headerBytes + header.bodyBytes
  if (!isString || end > bytes.length) return null
  try {
    return { key: keyDecoder.decode(bytes.subarray(offset + header.headerBytes, end)), end }
  } catch {
    return null
  }
}

export function topLevelMapKeys(bytes: Uint8Array): Set<string> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const top = headerAt(view, 0)
  if (top === null || top.bodyBytes !== 0) return null
  const tag = view.getUint8(0)
  if (!((tag >= 0x80 && tag <= 0x8f) || MAP_TAGS.has(tag))) return null
  const keys = new Set<string>()
  let offset = top.headerBytes
  for (let pair = 0; pair < top.children / 2; pair += 1) {
    const key = stringKeyAt(bytes, view, offset)
    if (key === null) return null
    const valueEnd = endOfValue(view, key.end)
    if (valueEnd === null) return null
    keys.add(key.key)
    offset = valueEnd
  }
  return keys
}

export function decodeMapWithoutFields(
  bytes: Uint8Array,
  skippedFields: ReadonlySet<string>,
): Record<string, unknown> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const top = headerAt(view, 0)
  if (top === null || top.children === 0 || top.bodyBytes !== 0) return null
  const tag = view.getUint8(0)
  const isMap = (tag >= 0x80 && tag <= 0x8f) || MAP_TAGS.has(tag)
  if (!isMap) return null

  const document: Record<string, unknown> = {}
  let offset = top.headerBytes
  for (let pair = 0; pair < top.children / 2; pair += 1) {
    const key = stringKeyAt(bytes, view, offset)
    if (key === null || FORBIDDEN_KEYS.has(key.key)) return null
    const valueEnd = endOfValue(view, key.end)
    if (valueEnd === null) return null
    if (!skippedFields.has(key.key)) {
      try {
        document[key.key] = decode(bytes.subarray(key.end, valueEnd))
      } catch {
        return null
      }
    }
    offset = valueEnd
  }
  return offset === bytes.length ? document : null
}
