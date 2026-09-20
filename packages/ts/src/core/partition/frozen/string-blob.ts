import { compareCodePoints } from '../../ordering'

export interface StringBlob {
  blob: Uint8Array
  offsets: Uint32Array
}

const SURROGATE = /[\ud800-\udfff]/
const encoder = new TextEncoder()

function encodeOneByOne(strings: readonly string[]): StringBlob {
  const encoded: Uint8Array[] = new Array(strings.length)
  let blobLength = 0
  for (let i = 0; i < strings.length; i++) {
    encoded[i] = encoder.encode(strings[i])
    blobLength += encoded[i].length
  }
  const blob = new Uint8Array(blobLength)
  const offsets = new Uint32Array(strings.length + 1)
  let cursor = 0
  for (let i = 0; i < strings.length; i++) {
    blob.set(encoded[i], cursor)
    cursor += encoded[i].length
    offsets[i + 1] = cursor
  }
  return { blob, offsets }
}

function basicPlaneUtf8Bytes(text: string): number {
  let bytes = text.length
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0x80) bytes += unit < 0x800 ? 1 : 2
  }
  return bytes
}

export function encodeStringBlob(strings: readonly string[]): StringBlob {
  const joined = strings.join('')
  if (SURROGATE.test(joined)) return encodeOneByOne(strings)
  const blob = encoder.encode(joined)
  const offsets = new Uint32Array(strings.length + 1)
  let cursor = 0
  for (let i = 0; i < strings.length; i++) {
    cursor += basicPlaneUtf8Bytes(strings[i])
    offsets[i + 1] = cursor
  }
  return cursor === blob.length ? { blob, offsets } : encodeOneByOne(strings)
}

function orderByComparator(strings: readonly string[]): number[] {
  const order: number[] = new Array(strings.length)
  for (let i = 0; i < strings.length; i++) order[i] = i
  return order.sort((a, b) => compareCodePoints(strings[a], strings[b]))
}

function alreadyInCodePointOrder(strings: readonly string[]): boolean {
  for (let i = 1; i < strings.length; i++) {
    if (compareCodePoints(strings[i - 1], strings[i]) > 0) return false
  }
  return true
}

export function codePointOrder(strings: readonly string[]): number[] {
  if (alreadyInCodePointOrder(strings)) return strings.map((_, i) => i)
  if (SURROGATE.test(strings.join(''))) return orderByComparator(strings)
  const positions = new Map<string, number>()
  for (let i = 0; i < strings.length; i++) positions.set(strings[i], i)
  if (positions.size !== strings.length) return orderByComparator(strings)
  const order: number[] = new Array(strings.length)
  const sorted = [...strings].sort()
  for (let i = 0; i < sorted.length; i++) order[i] = positions.get(sorted[i]) ?? 0
  return order
}
