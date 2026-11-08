import {
  lookupExact,
  lookupPrefix,
  mergeText,
  requireSegment,
  storedText,
  termCount,
  termText,
} from '../../engine/optional-reads-host-bindings'
import type { NativeExpansionSegment } from '../../vector/native/types/expansion'
import type { NativeTermDictionary } from '../../vector/native/types/terms'

const EMPTY_BYTES = new Uint8Array(0)
const EMPTY_WORDS = new Uint32Array(0)

export function expansionDictionary(source: NativeExpansionSegment): NativeTermDictionary {
  const growing = source.growing
  if (growing !== null)
    return {
      growing: growing.terms,
      tokens: EMPTY_BYTES,
      offsets: EMPTY_WORDS,
      frequencies: growing.columns.docFrequency,
      removed: growing.columns.deadDocuments,
    }
  const { frozen, state } = source
  requireSegment(frozen !== null && state !== null)
  return {
    growing: null,
    tokens: frozen.terms.text,
    offsets: frozen.terms.offsets,
    frequencies: frozen.terms.counts,
    removed: state.removedDocuments,
  }
}

export function validExpansionText(text: string): boolean {
  if (text.length > 0x40000000) return false
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at)
    if (unit < 0xd800 || unit >= 0xe000) continue
    if (unit >= 0xdc00 || ++at >= text.length) return false
    if (text.charCodeAt(at) < 0xdc00 || text.charCodeAt(at) >= 0xe000) return false
  }
  return true
}

export function expansionToken(dictionary: NativeTermDictionary, text: string): number | null {
  if (!validExpansionText(text)) return null
  const units = Uint16Array.from({ length: text.length }, (_, at) => text.charCodeAt(at))
  const output = new Uint32Array(1)
  const count = lookupExact(dictionary, units, output)
  requireSegment(count >= 0)
  return count === 0 ? null : output[0]
}

export function expansionPrefixes(dictionary: NativeTermDictionary, prefix: Uint16Array): Uint32Array {
  const output = new Uint32Array(termCount(dictionary))
  const count = lookupPrefix(dictionary, prefix, 0xffffffff, output)
  requireSegment(count >= 0)
  return output.subarray(0, count)
}

export function* expansionSurfaces(source: NativeExpansionSegment) {
  const dictionary = expansionDictionary(source)
  const growing = source.growing
  if (growing !== null) {
    const table = growing.surfaces
    if (table === null) return
    const strings = table.strings
    for (let entry = 0; entry < strings.header[0]; entry++) {
      const count = table.count[entry]
      if (count === 0 || table.token[entry] >= termCount(dictionary)) continue
      const from = strings.termOffset[entry]
      const length = strings.termLength[entry]
      if (from > strings.header[4] || length > strings.header[4] - from || length > 0x40000000) continue
      const token = termText(dictionary, table.token[entry])
      if (token === null || !validExpansionText(token)) continue
      const spelling = storedText(strings.units, from, length)
      if (validExpansionText(spelling)) yield { spelling, token, count, entry }
    }
    return
  }
  const { frozen, state } = source
  requireSegment(frozen !== null && state !== null)
  const table = frozen.surfaces
  if (table === null) return
  for (let entry = 0; entry < table.counts.length; entry++) {
    const count = table.counts[entry] - state.removedSurfaces[entry]
    if (count <= 0) continue
    const spelling = mergeText(table, entry * 2)
    const token = mergeText(table, entry * 2 + 1)
    if (spelling !== null && token !== null && validExpansionText(spelling) && validExpansionText(token))
      yield { spelling, token, count, entry }
  }
}

export function expansionOccurrences(source: NativeExpansionSegment, token: number, surfaces: number): number {
  const growing = source.growing
  if (growing !== null) return growing.columns.totalTermFrequency[token] - growing.columns.surfaceOccurrences[token]
  const { frozen, state } = source
  requireSegment(frozen !== null && state !== null)
  const slot = frozen.payloadSlots[token]
  if (slot >= frozen.terms.counts.length) return 0
  if (source.occurrences != null) return source.occurrences[slot] - state.removedOccurrences[token] - surfaces
  const start = frozen.postingOffsets[slot]
  const end = frozen.postingOffsets[slot + 1]
  if (start > end || end > frozen.postingDocuments.length) return 0
  let total = 0
  for (let at = start; at < end; at++)
    if (frozen.postingDocuments[at] < frozen.documentCount && frozen.postingFields[at] < frozen.partialFields.length)
      total += frozen.postingFrequencies[at]
  return total - state.removedOccurrences[token] - surfaces
}
