import {
  PENDING_TOKEN_WORDS,
  PENDING_TOKENS,
  PENDING_UNITS,
  requireSegment,
  storedText,
  textAt,
} from '#platform/frozen-kernel-host'
import type {
  NativeFrozenSegment,
  NativeFrozenSegmentState,
  NativeFrozenStrings,
} from '../../vector/native/types/frozen-segments'
import type { FrozenChanges } from './counts'
import { DistinctUnits } from './distinct-units'
import { NO_SURFACE } from './pending-writes'
import { tableAscends } from './table-order'
import { holdsLoneSurrogate, sameUnits } from './unit-order'

const SURFACE_STRIDE = 2
const STRING_STRIDE = 1
const UNTAGGED = 0
const NO_TERM_KEY = -1

const surfaceKeys = new DistinctUnits()
const termKeys = new DistinctUnits()
let tokenTerms = new Int32Array(0)

function requireUnits(state: NativeFrozenSegmentState, start: number, length: number): void {
  const units = state.pendingHeader[PENDING_UNITS]
  requireSegment(start <= units && length <= units - start)
}

function add(counts: Map<number, number>, entry: number, amount: number): void {
  counts.set(entry, (counts.get(entry) ?? 0) + amount)
}

function addResolved(counts: Map<number, number>, keys: DistinctUnits): void {
  for (let key = 0; key < keys.count; key++) if (keys.entries[key] >= 0) add(counts, keys.entries[key], keys.hits[key])
}

function countUnorderedSurfaces(changes: FrozenChanges, surfaces: NativeFrozenStrings, written: Map<string, number>) {
  for (let at = 0; at < surfaces.counts.length; at++) {
    const held = written.get(textAt(surfaces, at * 2) ?? '')
    if (held !== undefined) add(changes.surfaces, at, held)
  }
}

function countSpellings(
  changes: FrozenChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  spellings: NativeFrozenStrings,
  count: number,
): void {
  const units = state.pendingUnits
  termKeys.resolve(segment.terms, STRING_STRIDE, undefined)
  surfaceKeys.begin(units, count)
  for (let token = 0; token < count; token++) {
    const termKey = tokenTerms[token]
    if (termKey === NO_TERM_KEY) continue
    const termEntry = termKeys.entries[termKey]
    if (termEntry < 0) continue
    const at = token * PENDING_TOKEN_WORDS
    const start = state.pendingTokens[at + 3]
    const length = start === NO_SURFACE ? 0 : state.pendingTokens[at + 4]
    const spellingStart = length === 0 ? state.pendingTokens[at + 1] : start
    const spellingLength = length === 0 ? state.pendingTokens[at + 2] : length
    if (!holdsLoneSurrogate(units, spellingStart, spellingLength))
      surfaceKeys.add(spellingStart, spellingLength, termEntry)
  }
  surfaceKeys.resolve(spellings, STRING_STRIDE, segment.spellingTokens)
  addResolved(changes.spellings, surfaceKeys)
}

export function settleStringCounts(
  changes: FrozenChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
): void {
  const { surfaces, spellings, partialFields } = segment
  const ordered = surfaces === null || tableAscends(surfaces, SURFACE_STRIDE, undefined)
  let unordered: Map<string, number> | null = null
  const units = state.pendingUnits
  const count = state.pendingHeader[PENDING_TOKENS]
  surfaceKeys.begin(units, count)
  termKeys.begin(units, count)
  if (tokenTerms.length < count) tokenTerms = new Int32Array(count)
  for (let token = 0; token < count; token++) {
    const at = token * PENDING_TOKEN_WORDS
    const field = state.pendingTokens[at]
    const termStart = state.pendingTokens[at + 1]
    const termLength = state.pendingTokens[at + 2]
    const start = state.pendingTokens[at + 3]
    const length = start === NO_SURFACE ? 0 : state.pendingTokens[at + 4]
    requireSegment(field < partialFields.length)
    requireUnits(state, termStart, termLength)
    if (start !== NO_SURFACE) requireUnits(state, start, length)
    tokenTerms[token] = NO_TERM_KEY
    if (surfaces === null && spellings === null) continue
    if (surfaces !== null && length > 0 && !sameUnits(units, termStart, termLength, start, length)) {
      if (!ordered) {
        unordered ??= new Map()
        const text = storedText(units, start, length)
        unordered.set(text, (unordered.get(text) ?? 0) + 1)
      } else if (!holdsLoneSurrogate(units, start, length)) surfaceKeys.add(start, length, UNTAGGED)
    }
    if (spellings === null || partialFields[field] === 0) continue
    if (!holdsLoneSurrogate(units, termStart, termLength))
      tokenTerms[token] = termKeys.add(termStart, termLength, UNTAGGED)
  }
  if (surfaces !== null) {
    surfaceKeys.resolve(surfaces, SURFACE_STRIDE, undefined)
    addResolved(changes.surfaces, surfaceKeys)
    if (unordered !== null) countUnorderedSurfaces(changes, surfaces, unordered)
  }
  if (spellings !== null) countSpellings(changes, segment, state, spellings, count)
}
