import type { NativeExpansionSegment } from '../../vector/native/types/expansion'
import type { NativeFrozenRuns } from '../../vector/native/types/partial-expansion'
import type { NativeRunTable } from '../../vector/native/types/segments'
import { mergeText } from '../segment-merges/text'
import { hashRun } from '../segment-writes/runs'
import { storedText } from '../stored-values/text'
import { PARTIAL_RUN_POINTS } from './constants'
import { validExpansionText } from './source'

function growingRun(table: NativeRunTable, points: readonly number[]): number {
  const mask = table.slots.length - 1
  let slot = hashRun(points) & mask
  for (let scanned = 0; scanned < table.slots.length; scanned++) {
    const entry = table.slots[slot]
    if (entry === 0) return -1
    if (entry > 0 && entry <= table.header[0]) {
      const start = (entry - 1) * PARTIAL_RUN_POINTS
      if (points.every((point, at) => point === table.runs[start + at])) return entry - 1
    }
    slot = (slot + 1) & mask
  }
  return -1
}

function frozenRun(table: NativeFrozenRuns, points: readonly number[]): number {
  let low = 0
  let high = table.runs.length / PARTIAL_RUN_POINTS
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const start = middle * PARTIAL_RUN_POINTS
    const difference =
      table.runs[start] - points[0] || table.runs[start + 1] - points[1] || table.runs[start + 2] - points[2]
    if (difference === 0) return middle
    if (difference < 0) low = middle + 1
    else high = middle
  }
  return -1
}

export function partialMembers(
  source: NativeExpansionSegment,
  frozenRuns: NativeFrozenRuns | null,
  points: readonly number[],
): Uint32Array | null {
  const growing = source.growing?.spellings?.runs
  if (growing === undefined && frozenRuns === null) return null
  let selected: Uint32Array | null = null
  for (let at = 0; at + PARTIAL_RUN_POINTS <= points.length; at++) {
    const triple = points.slice(at, at + PARTIAL_RUN_POINTS)
    let members: Uint32Array
    if (growing !== undefined) {
      const run = growingRun(growing, triple)
      if (run < 0) return null
      const start = growing.listStart[run]
      const count = growing.listLength[run]
      const kind = growing.listClass[run]
      const allocated = growing.allocation[0]
      if (kind >= growing.sliceCapacities.length || allocated > growing.members.length || start > allocated) return null
      const capacity = growing.sliceCapacities[kind]
      if (count > capacity || capacity > allocated - start) return null
      members = growing.members.subarray(start, start + count)
    } else {
      if (frozenRuns === null) return null
      const run = frozenRun(frozenRuns, triple)
      if (run < 0) return null
      const start = frozenRuns.offsets[run]
      const end = frozenRuns.offsets[run + 1]
      if (start > end || end > frozenRuns.members.length) return null
      members = frozenRuns.members.subarray(start, end)
    }
    if (selected === null || members.length < selected.length) selected = members
  }
  return selected
}

export function partialSpelling(
  source: NativeExpansionSegment,
  ordinal: number,
): { text: string; token: number } | null {
  let text: string | null
  let token: number
  if (source.growing !== null) {
    const table = source.growing.spellings
    if (table === null || ordinal >= table.strings.header[0] || table.count[ordinal] === 0) return null
    const start = table.strings.termOffset[ordinal]
    const length = table.strings.termLength[ordinal]
    if (start > table.strings.header[4] || length > table.strings.header[4] - start || length > 0x40000000) return null
    text = storedText(table.strings.units, start, length)
    token = table.token[ordinal]
  } else {
    const table = source.frozen?.spellings
    const state = source.state
    if (
      table === undefined ||
      table === null ||
      state === null ||
      ordinal >= table.counts.length ||
      state.removedSpellings[ordinal] >= table.counts[ordinal]
    )
      return null
    text = mergeText(table, ordinal)
    token = source.frozen?.spellingTokens[ordinal] ?? 0xffffffff
  }
  return text === null || !validExpansionText(text) ? null : { text, token }
}
