import {
  PENDING_DOCUMENTS,
  PENDING_TOKENS,
  PENDING_UNITS,
  pendingSettled,
  readFrozenRequest,
  readFrozenSettle,
  requireRoom,
  requireSegment,
  SegmentRefusal,
} from '#platform/frozen-kernel-host'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import { clearTermChanges, type FrozenChanges, settleTermCounts, termChangesOf } from './counts'
import type { PendingSize } from './pending'
import { appendPending, pendingFits, pendingNeeds } from './pending-writes'
import { settleStringCounts } from './string-counts'
import type { FrozenPagedRemovals, PrepareFrozenRemoval, RemoveFrozenDocument, SettleFrozenState } from './types'

const PREPARED_REPLACEMENTS = 5

function clamped(removed: number, stored: number, amount: number): number {
  return Math.min(stored, removed + amount)
}

function publishTerms(
  changes: FrozenChanges,
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  paged: FrozenPagedRemovals | null,
): void {
  const { terms } = changes
  settleTermCounts(terms, segment, state, paged)
  settleStringCounts(changes, segment, state)
  for (const term of terms.touched)
    requireSegment(Number.isFinite(state.removedOccurrences[term]) && state.removedOccurrences[term] >= 0)
  for (const term of terms.touched) {
    state.removedDocuments[term] = clamped(
      state.removedDocuments[term],
      segment.terms.counts[term],
      terms.documents[term],
    )
    state.removedOccurrences[term] += terms.amounts[term]
  }
}

function settle(segment: NativeFrozenSegment, state: NativeFrozenSegmentState, paged: FrozenPagedRemovals | null) {
  if (pendingSettled(state)) return
  const changes: FrozenChanges = { terms: termChangesOf(segment), surfaces: new Map(), spellings: new Map() }
  try {
    publishTerms(changes, segment, state, paged)
  } finally {
    clearTermChanges(changes.terms)
  }
  if (segment.surfaces !== null)
    for (const [entry, amount] of changes.surfaces)
      state.removedSurfaces[entry] = clamped(state.removedSurfaces[entry], segment.surfaces.counts[entry], amount)
  if (segment.spellings !== null)
    for (const [entry, amount] of changes.spellings)
      state.removedSpellings[entry] = clamped(state.removedSpellings[entry], segment.spellings.counts[entry], amount)
  state.pendingHeader[PENDING_DOCUMENTS] = 0
  state.pendingHeader[PENDING_TOKENS] = 0
  state.pendingHeader[PENDING_UNITS] = 0
}

function tombstoned(state: NativeFrozenSegmentState, ordinal: number): boolean {
  return (state.tombstones[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0
}

function makeRoom(request: ReturnType<typeof readFrozenRequest>, paged: FrozenPagedRemovals | null): PendingSize {
  const { segment, state, fields } = request
  const needed = pendingNeeds(fields)
  requireRoom(pendingFits(state, needed, true))
  if (!pendingFits(state, needed, false)) settle(segment, state, paged)
  return needed
}

function refusal(error: unknown): number {
  if (error instanceof SegmentRefusal) return error.status
  throw error
}

export const removeFrozenDocument: RemoveFrozenDocument = (input, output, ordinal, tokens, paged) => {
  try {
    const request = readFrozenRequest(input, output, ordinal, tokens)
    const { segment, state, fields } = request
    if (tombstoned(state, ordinal)) return 0
    requireSegment(state.tombstoneCount[0] < segment.documentCount)
    const needed = makeRoom(request, paged)
    appendPending(state, ordinal, fields)
    state.pendingHeader[PENDING_DOCUMENTS] += needed.documents
    state.pendingHeader[PENDING_TOKENS] += needed.tokens
    state.pendingHeader[PENDING_UNITS] += needed.units
    state.tombstones[ordinal >>> 5] |= 1 << (ordinal & 31)
    state.tombstoneCount[0]++
    return 0
  } catch (error) {
    return refusal(error)
  }
}

export const prepareFrozenRemoval: PrepareFrozenRemoval = (
  input,
  output,
  ordinal,
  tokens,
  rawEntries,
  rawValues,
  paged,
) => {
  try {
    const request = readFrozenRequest(input, output, ordinal, tokens)
    const { entries, values } = request.readOutput(rawEntries, rawValues)
    const { segment, state, fields } = request
    if (tombstoned(state, ordinal)) return 0
    requireSegment(state.tombstoneCount[0] < segment.documentCount)
    requireRoom(entries.length / 2 >= PREPARED_REPLACEMENTS && values.length >= PREPARED_REPLACEMENTS)
    const needed = makeRoom(request, paged)
    appendPending(state, ordinal, fields)
    const header = state.pendingHeader
    const replacements = [
      [4, ordinal >>> 5, (state.tombstones[ordinal >>> 5] | (1 << (ordinal & 31))) >>> 0],
      [5, 0, state.tombstoneCount[0] + 1],
      [6, PENDING_DOCUMENTS, header[PENDING_DOCUMENTS] + needed.documents],
      [6, PENDING_TOKENS, header[PENDING_TOKENS] + needed.tokens],
      [6, PENDING_UNITS, header[PENDING_UNITS] + needed.units],
    ]
    for (let at = 0; at < replacements.length; at++) {
      entries[at * 2] = replacements[at][0]
      entries[at * 2 + 1] = replacements[at][1]
      values[at] = replacements[at][2]
    }
    return PREPARED_REPLACEMENTS
  } catch (error) {
    return -refusal(error)
  }
}

export const settleFrozenState: SettleFrozenState = (input, output, paged) => {
  try {
    const { segment, state } = readFrozenSettle(input, output)
    settle(segment, state, paged)
    return 0
  } catch (error) {
    return refusal(error)
  }
}
