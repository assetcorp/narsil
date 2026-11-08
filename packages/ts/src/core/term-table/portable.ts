import type { NativeTermCore, NativeTermDictionary, NativeTermTable } from '../../vector/native/types/terms'
import { boundedLevenshtein, fuzzyPrefixOf } from '../fuzzy'
import { FNV_OFFSET_BASIS, FNV_PRIME, fnv1aUtf16 } from '../hash'
import { compareCodePoints } from '../ordering'
import { regionsOverlap } from '../regions'
import { typedRegion } from '../stored-values/regions'
import { storedText } from '../stored-values/text'
import { TERM_REGION_GROWTH_FACTOR } from './constants'
import { dictionaryRegions, liveFrequency, readDictionary, termCount, termText } from './read'

function uint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

function startsWithCodePoints(text: string, prefix: string): boolean {
  return text.startsWith(prefix) && prefix.codePointAt(prefix.length - 1) === text.codePointAt(prefix.length - 1)
}

function equalsQuery(dictionary: NativeTermDictionary, ordinal: number, query: Uint16Array): boolean {
  const table = dictionary.growing
  if (table === null || table.termLength[ordinal] !== query.length) return false
  const start = table.termOffset[ordinal]
  if (start > table.header[4] || query.length > table.header[4] - start) return false
  for (let at = 0; at < query.length; at++) if (table.units[start + at] !== query[at]) return false
  return true
}

function exact(dictionary: NativeTermDictionary, query: Uint16Array): number | undefined {
  const table = dictionary.growing
  if (table !== null) {
    let hash = FNV_OFFSET_BASIS
    for (const unit of query) {
      hash = Math.imul(hash ^ (unit & 255), FNV_PRIME)
      hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME)
    }
    const mask = table.slots.length - 1
    let slot = hash & mask
    for (let scanned = 0; scanned < table.slots.length; scanned++) {
      const entry = table.slots[slot]
      if (entry === 0) return undefined
      if (
        entry > 0 &&
        entry <= table.header[0] &&
        liveFrequency(dictionary, entry - 1) > 0 &&
        equalsQuery(dictionary, entry - 1, query)
      )
        return entry - 1
      slot = (slot + 1) & mask
    }
    return undefined
  }
  const text = storedText(query, 0, query.length)
  let low = 0
  let high = termCount(dictionary)
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = termText(dictionary, middle)
    if (candidate === null) {
      for (let at = 0; at < termCount(dictionary); at++) {
        if (liveFrequency(dictionary, at) > 0 && termText(dictionary, at) === text) return at
      }
      return undefined
    }
    const order = compareCodePoints(candidate, text)
    if (order === 0) return liveFrequency(dictionary, middle) > 0 ? middle : undefined
    if (order < 0) low = middle + 1
    else high = middle
  }
  return undefined
}

function equalsText(table: NativeTermTable, ordinal: number, text: string): boolean {
  if (table.termLength[ordinal] !== text.length) return false
  const start = table.termOffset[ordinal]
  if (start > table.header[4] || text.length > table.header[4] - start) return false
  for (let at = 0; at < text.length; at++) if (table.units[start + at] !== text.charCodeAt(at)) return false
  return true
}

export function findOwnedTerm(dictionary: NativeTermDictionary, text: string): number | undefined | null {
  const table = dictionary.growing
  if (table === null) return null
  const mask = table.slots.length - 1
  let slot = fnv1aUtf16(text) & mask
  for (let scanned = 0; scanned < table.slots.length; scanned++) {
    const entry = table.slots[slot]
    if (entry === 0) return undefined
    if (
      entry > 0 &&
      entry <= table.header[0] &&
      liveFrequency(dictionary, entry - 1) > 0 &&
      equalsText(table, entry - 1, text)
    )
      return entry - 1
    slot = (slot + 1) & mask
  }
  return undefined
}

function* candidates(dictionary: NativeTermDictionary, prefix: string): Generator<number> {
  const table = dictionary.growing
  const count = termCount(dictionary)
  if (table === null || prefix.length === 0) {
    const first = table === null && prefix.length > 0 ? prefixBound(dictionary, prefix, false) : 0
    const last = table === null && prefix.length > 0 ? prefixBound(dictionary, prefix, true) : count
    const start = first < 0 || last < first ? 0 : first
    const end = first < 0 || last < first ? count : last
    for (let ordinal = start; ordinal < end; ordinal++) yield ordinal
    return
  }
  const seen = new Set<number>()
  let entry = table.firstUnitHead[prefix.charCodeAt(0)]
  while (entry > 0 && entry <= count && !seen.has(entry)) {
    seen.add(entry)
    yield entry - 1
    entry = table.firstUnitNext[entry - 1]
  }
}

function prefixBound(dictionary: NativeTermDictionary, prefix: string, upper: boolean): number {
  let low = 0
  let high = termCount(dictionary)
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = termText(dictionary, middle)
    if (candidate === null) return -1
    const order = startsWithCodePoints(candidate, prefix) ? 0 : compareCodePoints(candidate, prefix)
    if (order < 0 || (upper && order === 0)) low = middle + 1
    else high = middle
  }
  return low
}

function lookup(
  input: NativeTermDictionary,
  query: Uint16Array,
  operation: number,
  limit: number,
  tolerance: number,
  prefixLength: number,
  output: Uint32Array,
): number {
  const dictionary = readDictionary(input)
  const units = typedRegion(query, 'Uint16Array')
  const into = typedRegion(output, 'Uint32Array')
  if (
    dictionary === null ||
    units === null ||
    into === null ||
    units.length > 0x40000000 ||
    !uint32(limit) ||
    !uint32(tolerance) ||
    !uint32(prefixLength)
  )
    return -1
  if ([...dictionaryRegions(dictionary), units].some(region => regionsOverlap(region, into))) return -1
  if (operation === 0 || (operation === 2 && tolerance === 0)) {
    const ordinal = exact(dictionary, units)
    if (ordinal === undefined) return 0
    if (into.length === 0) return -3
    into[0] = ordinal
    return 1
  }
  const text = storedText(units, 0, units.length)
  if (operation === 1 && (text.length === 0 || limit === 0)) return 0
  const prefix = operation === 1 ? text : fuzzyPrefixOf(text, prefixLength)
  const found: Array<{ ordinal: number; text: string; frequency: number }> = []
  for (const ordinal of candidates(dictionary, prefix)) {
    const frequency = liveFrequency(dictionary, ordinal)
    if (frequency === 0) continue
    const candidate = termText(dictionary, ordinal)
    if (candidate === null || !startsWithCodePoints(candidate, prefix)) continue
    if (
      operation === 2 &&
      tolerance < Math.max(text.length, candidate.length) &&
      !boundedLevenshtein(text, candidate, tolerance).withinTolerance
    )
      continue
    found.push({ ordinal, text: candidate, frequency })
  }
  found.sort(
    (left, right) =>
      (operation === 1 ? right.frequency - left.frequency : 0) ||
      compareCodePoints(left.text, right.text) ||
      left.ordinal - right.ordinal,
  )
  const count = operation === 1 ? Math.min(limit, found.length) : found.length
  if (count > into.length) return -3
  for (let at = 0; at < count; at++) into[at] = found[at].ordinal
  return count
}

export const lookupExact: NativeTermCore['lookupExact'] = (dictionary, text, output) =>
  lookup(dictionary, text, 0, 0, 0, 0, output)

let batchResults = new Uint32Array(0)

export const lookupExactBatch: NativeTermCore['lookupExactBatch'] = (input, text, boundaries, output) => {
  const dictionary = readDictionary(input)
  const units = typedRegion(text, 'Uint16Array')
  const offsets = typedRegion(boundaries, 'Uint32Array')
  const into = typedRegion(output, 'Uint32Array')
  if (
    dictionary === null ||
    units === null ||
    offsets === null ||
    into === null ||
    units.length > 0xffffffff ||
    offsets.length === 0 ||
    offsets.length - 1 > 0xffffffff
  )
    return -1
  if ([...dictionaryRegions(dictionary), units, offsets].some(region => regionsOverlap(region, into))) return -1
  const count = offsets.length - 1
  if (offsets[0] !== 0 || offsets[count] !== units.length) return -1
  for (let at = 0; at < count; at++) {
    if (offsets[at + 1] < offsets[at] || offsets[at + 1] - offsets[at] > 0x40000000) return -1
  }
  if (count > into.length) return -3
  try {
    if (count > batchResults.length)
      batchResults = new Uint32Array(
        Math.max(count, Math.min(0xffffffff, batchResults.length * TERM_REGION_GROWTH_FACTOR)),
      )
    for (let at = 0; at < count; at++)
      batchResults[at] = exact(dictionary, units.subarray(offsets[at], offsets[at + 1])) ?? 0xffffffff
    into.set(batchResults.subarray(0, count))
    return count
  } catch (error) {
    if (error instanceof RangeError) return -2
    throw error
  }
}

export const lookupPrefix: NativeTermCore['lookupPrefix'] = (dictionary, text, limit, output) =>
  lookup(dictionary, text, 1, limit, 0, 0, output)

export const lookupTypo: NativeTermCore['lookupTypo'] = (dictionary, text, tolerance, prefixLength, output) =>
  lookup(dictionary, text, 2, 0, tolerance, prefixLength, output)

export const documentFrequency: NativeTermCore['documentFrequency'] = (input, ordinal, output) => {
  const dictionary = readDictionary(input)
  const into = typedRegion(output, 'Uint32Array')
  if (dictionary === null || into === null || !uint32(ordinal) || ordinal >= termCount(dictionary)) return -1
  if (dictionaryRegions(dictionary).some(region => regionsOverlap(region, into))) return -1
  if (into.length === 0) return -3
  into[0] = liveFrequency(dictionary, ordinal)
  return 0
}
