import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import { compareBytes, encodeLookupKey } from '../partition/frozen/string-blob'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function textAt(table: NativeFrozenStrings, offset: number): string | null {
  const start = table.offsets[offset]
  const end = table.offsets[offset + 1]
  if (start > end || end > table.text.length) return null
  try {
    const text = decoder.decode(table.text.subarray(start, end))
    return text.length > 0x40000000 ? null : text
  } catch {
    return null
  }
}

export function findEntry(table: NativeFrozenStrings, text: string, stride = 1, tokens?: Uint32Array, token = 0) {
  const query = encodeLookupKey(text)
  let low = 0
  let high = table.counts.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const start = table.offsets[middle * stride]
    const end = table.offsets[middle * stride + 1]
    if (start > end || end > table.text.length) break
    const order = compareBytes(table.text, start, end, query) || (tokens === undefined ? 0 : tokens[middle] - token)
    if (order === 0) return middle
    if (order < 0) low = middle + 1
    else high = middle
  }
  if (low === high) return -1
  for (let at = 0; at < table.counts.length; at++)
    if ((tokens === undefined || tokens[at] === token) && textAt(table, at * stride) === text) return at
  return -1
}
