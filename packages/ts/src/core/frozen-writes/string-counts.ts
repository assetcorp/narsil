import {
  compareBytes,
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

const UTF8_LEADS = [0, 0, 0xc0, 0xe0, 0xf0]
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

function requireUnits(state: NativeFrozenSegmentState, start: number, length: number): void {
  const units = state.pendingHeader[PENDING_UNITS]
  requireSegment(start <= units && length <= units - start)
}

function holdsLoneSurrogate(units: Uint16Array, start: number, length: number): boolean {
  const end = start + length
  for (let at = start; at < end; at++) {
    const unit = units[at]
    if (unit < 0xd800 || unit >= 0xe000) continue
    if (unit >= 0xdc00 || at + 1 >= end || units[at + 1] < 0xdc00 || units[at + 1] >= 0xe000) return true
    at++
  }
  return false
}

function utf8Width(point: number): number {
  if (point < 0x80) return 1
  if (point < 0x800) return 2
  return point < 0x10000 ? 3 : 4
}

function utf8Byte(point: number, width: number, index: number): number {
  if (width === 1) return point
  const shift = 6 * (width - 1 - index)
  return index === 0 ? UTF8_LEADS[width] | (point >> shift) : 0x80 | ((point >> shift) & 0x3f)
}

function compareTableToUnits(
  table: Uint8Array,
  from: number,
  to: number,
  units: Uint16Array,
  start: number,
  length: number,
): number {
  let byte = from
  const end = start + length
  for (let at = start; at < end; at++) {
    let point = units[at]
    if (point >= 0xd800 && point < 0xdc00) point = 0x10000 + ((point - 0xd800) << 10) + (units[++at] - 0xdc00)
    const width = utf8Width(point)
    for (let index = 0; index < width; index++) {
      if (byte >= to) return -1
      const order = table[byte++] - utf8Byte(point, width, index)
      if (order !== 0) return order
    }
  }
  return byte < to ? 1 : 0
}

function findUnits(
  table: NativeFrozenStrings,
  units: Uint16Array,
  start: number,
  length: number,
  stride: number,
  tokens?: Uint32Array,
  token = 0,
): number {
  if (holdsLoneSurrogate(units, start, length)) return -1
  let low = 0
  let high = table.counts.length
  while (low < high) {
    const middle = low + ((high - low) >>> 1)
    const from = table.offsets[middle * stride]
    const to = table.offsets[middle * stride + 1]
    if (from > to || to > table.text.length) break
    const order =
      compareTableToUnits(table.text, from, to, units, start, length) ||
      (tokens === undefined ? 0 : tokens[middle] - token)
    if (order === 0) return middle
    if (order < 0) low = middle + 1
    else high = middle
  }
  if (low === high) return -1
  for (let at = 0; at < table.counts.length; at++) {
    const from = table.offsets[at * stride]
    const to = table.offsets[at * stride + 1]
    if ((tokens === undefined || tokens[at] === token) && from <= to && to <= table.text.length)
      if (compareTableToUnits(table.text, from, to, units, start, length) === 0) return at
  }
  return -1
}

function sameUnits(units: Uint16Array, left: number, leftLength: number, right: number, rightLength: number) {
  if (leftLength !== rightLength) return false
  for (let at = 0; at < leftLength; at++) if (units[left + at] !== units[right + at]) return false
  return true
}

function add(counts: Map<number, number>, entry: number, amount: number): void {
  counts.set(entry, (counts.get(entry) ?? 0) + amount)
}

function countUnorderedSurfaces(changes: FrozenChanges, surfaces: NativeFrozenStrings, written: Map<string, number>) {
  for (let at = 0; at < surfaces.counts.length; at++) {
    const held = written.get(textAt(surfaces, at * 2) ?? '')
    if (held !== undefined) add(changes.surfaces, at, held)
  }
}

export function settleStringCounts(
  changes: FrozenChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
): void {
  const { surfaces, spellings, partialFields } = segment
  const ordered = surfaces === null || surfacesAscend(surfaces)
  const unordered = new Map<string, number>()
  const units = state.pendingUnits
  const count = state.pendingHeader[PENDING_TOKENS]
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
    if (surfaces === null && spellings === null) continue
    const spellingStart = length === 0 ? termStart : start
    const spellingLength = length === 0 ? termLength : length
    if (surfaces !== null && length > 0 && !sameUnits(units, termStart, termLength, start, length)) {
      if (!ordered) {
        const text = storedText(units, start, length)
        unordered.set(text, (unordered.get(text) ?? 0) + 1)
      } else {
        const entry = findUnits(surfaces, units, start, length, 2)
        if (entry >= 0) add(changes.surfaces, entry, 1)
      }
    }
    if (spellings === null || partialFields[field] === 0) continue
    const termEntry = findUnits(segment.terms, units, termStart, termLength, 1)
    if (termEntry < 0) continue
    const entry = findUnits(spellings, units, spellingStart, spellingLength, 1, segment.spellingTokens, termEntry)
    if (entry >= 0) add(changes.spellings, entry, 1)
  }
  if (surfaces !== null && unordered.size > 0) countUnorderedSurfaces(changes, surfaces, unordered)
}
