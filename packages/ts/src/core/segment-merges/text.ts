import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const MAX_MERGE_TEXT_UNITS = 0x40000000

export function mergeText(table: NativeFrozenStrings, at: number): string | null {
  const start = table.offsets[at]
  const end = table.offsets[at + 1]
  if (start >= end || end > table.text.length) return null
  try {
    const text = decoder.decode(table.text.subarray(start, end))
    return text.length > MAX_MERGE_TEXT_UNITS ? null : text
  } catch {
    return null
  }
}

export function mergeTextBytes(table: NativeFrozenStrings, at: number): Uint8Array | null {
  const start = table.offsets[at]
  const end = table.offsets[at + 1]
  if (start >= end || end > table.text.length) return null
  const bytes = table.text.subarray(start, end)
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] >= 0x80) return mergeText(table, at) === null ? null : bytes
  }
  return bytes.length > MAX_MERGE_TEXT_UNITS ? null : bytes
}

export function compareMergeBytes(left: Uint8Array, right: Uint8Array): number {
  const shorter = left.length < right.length ? left.length : right.length
  for (let index = 0; index < shorter; index++) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return left.length - right.length
}

export function decodeMergeText(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}
