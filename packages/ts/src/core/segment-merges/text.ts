import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function mergeText(table: NativeFrozenStrings, at: number): string | null {
  const start = table.offsets[at]
  const end = table.offsets[at + 1]
  if (start >= end || end > table.text.length) return null
  try {
    const text = decoder.decode(table.text.subarray(start, end))
    return text.length > 0x40000000 ? null : text
  } catch {
    return null
  }
}
