import { decode } from '@msgpack/msgpack'

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const keyDecoder = new TextDecoder('utf-8', { fatal: true })

interface ValueHeader {
  headerBytes: number
  bodyBytes: number
  children: number
}

function headerAt(view: DataView, offset: number): ValueHeader | null {
  if (offset >= view.byteLength) return null
  const tag = view.getUint8(offset)
  if (tag <= 0x7f || tag >= 0xe0) return { headerBytes: 1, bodyBytes: 0, children: 0 }
  if (tag <= 0x8f) return { headerBytes: 1, bodyBytes: 0, children: (tag & 0x0f) * 2 }
  if (tag <= 0x9f) return { headerBytes: 1, bodyBytes: 0, children: tag & 0x0f }
  if (tag <= 0xbf) return { headerBytes: 1, bodyBytes: tag & 0x1f, children: 0 }
  const lengthBytes = LENGTH_BYTES_BY_TAG.get(tag)
  if (lengthBytes !== undefined) {
    if (offset + 1 + lengthBytes > view.byteLength) return null
    const length =
      lengthBytes === 1
        ? view.getUint8(offset + 1)
        : lengthBytes === 2
          ? view.getUint16(offset + 1, false)
          : view.getUint32(offset + 1, false)
    const headerBytes = 1 + lengthBytes
    if (ARRAY_TAGS.has(tag)) return { headerBytes, bodyBytes: 0, children: length }
    if (MAP_TAGS.has(tag)) return { headerBytes, bodyBytes: 0, children: length * 2 }
    return { headerBytes, bodyBytes: length + (EXT_TAGS.has(tag) ? 1 : 0), children: 0 }
  }
  const fixedBytes = FIXED_BODY_BYTES_BY_TAG.get(tag)
  return fixedBytes === undefined ? null : { headerBytes: 1, bodyBytes: fixedBytes, children: 0 }
}

const LENGTH_BYTES_BY_TAG = new Map<number, number>([
  [0xc4, 1],
  [0xc5, 2],
  [0xc6, 4],
  [0xc7, 1],
  [0xc8, 2],
  [0xc9, 4],
  [0xd9, 1],
  [0xda, 2],
  [0xdb, 4],
  [0xdc, 2],
  [0xdd, 4],
  [0xde, 2],
  [0xdf, 4],
])
const ARRAY_TAGS = new Set([0xdc, 0xdd])
const MAP_TAGS = new Set([0xde, 0xdf])
const EXT_TAGS = new Set([0xc7, 0xc8, 0xc9])
const FIXED_BODY_BYTES_BY_TAG = new Map<number, number>([
  [0xc0, 0],
  [0xc2, 0],
  [0xc3, 0],
  [0xca, 4],
  [0xcb, 8],
  [0xcc, 1],
  [0xcd, 2],
  [0xce, 4],
  [0xcf, 8],
  [0xd0, 1],
  [0xd1, 2],
  [0xd2, 4],
  [0xd3, 8],
  [0xd4, 2],
  [0xd5, 3],
  [0xd6, 5],
  [0xd7, 9],
  [0xd8, 17],
])

function endOfValue(view: DataView, start: number): number | null {
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
