import type { NativeFrozenSegment, NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { compareCodePoints } from '../ordering'
import { storedText } from '../stored-values/text'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function textAt(table: NativeFrozenStrings, offset: number): string | null {
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

function findEntry(table: NativeFrozenStrings, text: string, tokens?: Uint32Array, token = 0): number {
  let low = 0
  let high = table.counts.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const held = textAt(table, middle)
    if (held === null) break
    const order = compareCodePoints(held, text) || (tokens === undefined ? 0 : tokens[middle] - token)
    if (order === 0) return middle
    if (order < 0) low = middle + 1
    else high = middle
  }
  if (low === high) return -1
  for (let at = 0; at < table.counts.length; at++)
    if ((tokens === undefined || tokens[at] === token) && textAt(table, at) === text) return at
  return -1
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
      const entry = findEntry(segment.spellings, spelling, segment.spellingTokens, token)
      if (entry >= 0) spellings.set(entry, (spellings.get(entry) ?? 0) + 1)
    }
  }
  if (segment.surfaces !== null && written.size > 0) {
    for (let at = 0; at < segment.surfaces.counts.length; at++) {
      const spelling = textAt(segment.surfaces, at * 2)
      if (spelling === null) continue
      const count = written.get(spelling)
      if (count !== undefined) surfaces.set(at, count)
    }
  }
  return { surfaces, spellings }
}
