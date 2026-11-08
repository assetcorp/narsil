import type { NativeFrozenSegmentCore } from '../../vector/native/types/frozen-segments'
import { requireRoom, requireSegment, SegmentRefusal } from '../segment-writes/status'
import { removedTermCounts } from './counts'
import { readFrozenRequest } from './regions'
import { removedStringCounts } from './strings'

type Request = ReturnType<typeof readFrozenRequest>

function collect(request: Request, ordinal: number) {
  const { segment, state, fields } = request
  if ((state.tombstones[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0) return null
  requireSegment(state.tombstoneCount[0] < segment.documentCount)
  const terms = removedTermCounts(segment, ordinal)
  const { surfaces, spellings } = removedStringCounts(segment, fields)
  for (const term of terms.keys())
    requireSegment(Number.isFinite(state.removedOccurrences[term]) && state.removedOccurrences[term] >= 0)
  return { terms, surfaces, spellings }
}

function visitUpdates(
  request: Request,
  changes: NonNullable<ReturnType<typeof collect>>,
  ordinal: number,
  visit: (kind: number, entry: number, value: number) => void,
): void {
  const { segment, state } = request
  for (const [term, count] of changes.terms) {
    visit(0, term, state.removedDocuments[term] + Number(state.removedDocuments[term] < segment.terms.counts[term]))
    visit(1, term, state.removedOccurrences[term] + count)
  }
  if (segment.surfaces !== null)
    for (const [entry, count] of changes.surfaces)
      visit(2, entry, Math.min(segment.surfaces.counts[entry], state.removedSurfaces[entry] + count))
  if (segment.spellings !== null)
    for (const [entry, count] of changes.spellings)
      visit(3, entry, Math.min(segment.spellings.counts[entry], state.removedSpellings[entry] + count))
  visit(4, ordinal >>> 5, (state.tombstones[ordinal >>> 5] | (1 << (ordinal & 31))) >>> 0)
  visit(5, 0, state.tombstoneCount[0] + 1)
}

export const removeFrozenDocument: NativeFrozenSegmentCore['removeFrozenDocument'] = (
  input,
  output,
  ordinal,
  tokens,
) => {
  try {
    const request = readFrozenRequest(input, output, ordinal, tokens)
    const changes = collect(request, ordinal)
    if (changes === null) return 0
    const state = request.state
    const regions = [
      state.removedDocuments,
      state.removedOccurrences,
      state.removedSurfaces,
      state.removedSpellings,
      state.tombstones,
      state.tombstoneCount,
    ]
    visitUpdates(request, changes, ordinal, (kind, entry, value) => {
      regions[kind][entry] = value
    })
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}

export const prepareFrozenRemoval: NativeFrozenSegmentCore['prepareFrozenRemoval'] = (
  input,
  state,
  ordinal,
  tokens,
  rawEntries,
  rawValues,
) => {
  try {
    const request = readFrozenRequest(input, state, ordinal, tokens)
    const { entries, values } = request.readOutput(rawEntries, rawValues)
    const changes = collect(request, ordinal)
    if (changes === null) return 0
    const needed = changes.terms.size * 2 + changes.surfaces.size + changes.spellings.size + 2
    requireRoom(needed <= entries.length / 2 && needed <= values.length)
    let at = 0
    const ordered = {
      terms: new Map([...changes.terms].sort(([left], [right]) => left - right)),
      surfaces: changes.surfaces,
      spellings: new Map([...changes.spellings].sort(([left], [right]) => left - right)),
    }
    visitUpdates(request, ordered, ordinal, (kind, entry, value) => {
      entries[at * 2] = kind
      entries[at * 2 + 1] = entry
      values[at++] = value
    })
    return needed
  } catch (error) {
    if (error instanceof SegmentRefusal) return -error.status
    throw error
  }
}
