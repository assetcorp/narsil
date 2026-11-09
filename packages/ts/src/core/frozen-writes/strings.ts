import type { NativeFrozenSegment, NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { compareBytes, encodeLookupKey } from '../partition/frozen/string-blob'
import { storedText } from '../stored-values/text'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const surfaceOrders = new WeakMap<ArrayBufferLike, { offsets: Uint32Array; text: Uint8Array; ascends: boolean }>()

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

function sameView(left: ArrayBufferView, right: ArrayBufferView): boolean {
  return left.buffer === right.buffer && left.byteOffset === right.byteOffset && left.byteLength === right.byteLength
}

function surfacesAscend({ offsets, text, counts }: NativeFrozenStrings): boolean {
  const held = surfaceOrders.get(offsets.buffer)
  if (held !== undefined && sameView(held.offsets, offsets) && sameView(held.text, text)) return held.ascends
  let ascends = true
  for (let entry = 0; entry < counts.length && ascends; entry++) {
    const start = offsets[entry * 2]
    const end = offsets[entry * 2 + 1]
    ascends =
      start <= end &&
      end <= text.length &&
      (entry === 0 || compareBytes(text, offsets[entry * 2 - 2], offsets[entry * 2 - 1], text.subarray(start, end)) < 0)
  }
  surfaceOrders.set(offsets.buffer, { offsets, text, ascends })
  return ascends
}

export function removedStringCounts(segment: NativeFrozenSegment, fields: readonly NativeFieldTokens[]) {
  const surfaces = new Map<number, number>()
  const spellings = new Map<number, number>()
  const written = new Map<string, number>()
  if (segment.surfaces === null && segment.spellings === null) return { surfaces, spellings }
  for (const field of fields) {
    for (let at = 0; at < field.tokens.length; at += 8) {
      const term = storedText(field.units, field.tokens[at + 1], field.tokens[at + 2])
      const start = field.tokens[at + 3]
      const length = field.tokens[at + 4]
      const spelling = start === 0xffffffff || length === 0 ? term : storedText(field.units, start, length)
      if (segment.surfaces !== null && spelling !== term)
        written.set(spelling, Math.min(0xffffffff, (written.get(spelling) ?? 0) + 1))
      if (segment.spellings === null || segment.partialFields[field.field] === 0) continue
      const token = findEntry(segment.terms, term)
      if (token < 0) continue
      const entry = findEntry(segment.spellings, spelling, 1, segment.spellingTokens, token)
      if (entry >= 0) spellings.set(entry, (spellings.get(entry) ?? 0) + 1)
    }
  }
  if (segment.surfaces === null || written.size === 0) return { surfaces, spellings }
  const ascends = surfacesAscend(segment.surfaces)
  for (let at = 0; !ascends && at < segment.surfaces.counts.length; at++) {
    const count = written.get(textAt(segment.surfaces, at * 2) ?? '')
    if (count !== undefined) surfaces.set(at, count)
  }
  for (const [spelling, count] of ascends ? written : []) {
    const entry = findEntry(segment.surfaces, spelling, 2)
    if (entry >= 0) surfaces.set(entry, count)
  }
  return { surfaces, spellings }
}
