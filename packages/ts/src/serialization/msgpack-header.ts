export interface ValueHeader {
  headerBytes: number
  bodyBytes: number
  children: number
}

export function headerAt(view: DataView, offset: number): ValueHeader | null {
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
export const MAP_TAGS = new Set([0xde, 0xdf])
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
