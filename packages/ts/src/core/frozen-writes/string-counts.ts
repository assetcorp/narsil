import {
  compareBytes,
  findEntry,
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
import { NO_SURFACE } from './pending-writes'

const surfaceOrders = new WeakMap<ArrayBufferLike, { offsets: Uint32Array; text: Uint8Array; ascends: boolean }>()

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

function pendingText(state: NativeFrozenSegmentState, start: number, length: number): string {
  const units = state.pendingHeader[PENDING_UNITS]
  requireSegment(start <= units && length <= units - start)
  return storedText(state.pendingUnits, start, length)
}

export function settleStringCounts(
  changes: FrozenChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
): void {
  const written = new Map<string, number>()
  const count = state.pendingHeader[PENDING_TOKENS]
  for (let token = 0; token < count; token++) {
    const at = token * PENDING_TOKEN_WORDS
    const field = state.pendingTokens[at]
    const start = state.pendingTokens[at + 3]
    const length = state.pendingTokens[at + 4]
    requireSegment(field < segment.partialFields.length)
    const term = pendingText(state, state.pendingTokens[at + 1], state.pendingTokens[at + 2])
    const surface = start === NO_SURFACE ? '' : pendingText(state, start, length)
    if (segment.surfaces === null && segment.spellings === null) continue
    const spelling = surface.length === 0 ? term : surface
    if (segment.surfaces !== null && spelling !== term)
      written.set(spelling, Math.min(0xffffffff, (written.get(spelling) ?? 0) + 1))
    if (segment.spellings === null || segment.partialFields[field] === 0) continue
    const termEntry = findEntry(segment.terms, term)
    if (termEntry < 0) continue
    const entry = findEntry(segment.spellings, spelling, 1, segment.spellingTokens, termEntry)
    if (entry >= 0) changes.spellings.set(entry, (changes.spellings.get(entry) ?? 0) + 1)
  }
  if (segment.surfaces === null || written.size === 0) return
  const ascends = surfacesAscend(segment.surfaces)
  for (let at = 0; !ascends && at < segment.surfaces.counts.length; at++) {
    const held = written.get(textAt(segment.surfaces, at * 2) ?? '')
    if (held !== undefined) changes.surfaces.set(at, (changes.surfaces.get(at) ?? 0) + held)
  }
  for (const [spelling, held] of ascends ? written : []) {
    const entry = findEntry(segment.surfaces, spelling, 2)
    if (entry >= 0) changes.surfaces.set(entry, (changes.surfaces.get(entry) ?? 0) + held)
  }
}
