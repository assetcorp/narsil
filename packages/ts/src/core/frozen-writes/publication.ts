import { growFrozenRemovalRegions, prepareFrozenRemoval, settleFrozenState } from '#platform/frozen-writes'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { PENDING_DOCUMENTS, PENDING_HEADER_WORDS, PENDING_TOKENS, PENDING_UNITS, pendingSettled } from './pending'
import type { FrozenPagedRemovals } from './types'

export type { FrozenPagedRemovals } from './types'

export type FrozenStringRegions = Pick<
  NativeFrozenSegment,
  'surfaces' | 'spellings' | 'spellingTokens' | 'partialFields'
> &
  Pick<NativeFrozenSegmentState, 'removedSurfaces' | 'removedSpellings'>

export interface FrozenRemovals {
  prepare(ordinal: number, fields: readonly NativeFieldTokens[], strings?: FrozenStringRegions): () => void
  pending(): boolean
  settle(): void
  bytes(): number
}

const NEEDS_ROOM = -3
const PREPARED_REPLACEMENTS = 5
const FIRST_PREPARED_KIND = 4

const entries = new Uint32Array(PREPARED_REPLACEMENTS * 2)
const values = new Float64Array(PREPARED_REPLACEMENTS)

function corrupted(status: number): never {
  throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The frozen segment refused a document removal', { status })
}

export function emptyPendingRegions(): Pick<
  NativeFrozenSegmentState,
  'pendingHeader' | 'pendingDocuments' | 'pendingTokens' | 'pendingUnits'
> {
  return {
    pendingHeader: new Uint32Array(PENDING_HEADER_WORDS),
    pendingDocuments: new Uint32Array(0),
    pendingTokens: new Uint32Array(0),
    pendingUnits: new Uint16Array(0),
  }
}

export function createFrozenRemovals(
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  paged: FrozenPagedRemovals | null,
): FrozenRemovals {
  function settle(): void {
    if (pendingSettled(state)) return
    const status = settleFrozenState(segment, state, paged)
    if (status !== 0) corrupted(status)
  }

  function prepareCount(ordinal: number, fields: readonly NativeFieldTokens[]): number {
    growFrozenRemovalRegions(segment, state, fields)
    const count = prepareFrozenRemoval(segment, state, ordinal, fields, entries, values, paged)
    if (count !== NEEDS_ROOM) return count
    growFrozenRemovalRegions(segment, state, fields)
    return prepareFrozenRemoval(segment, state, ordinal, fields, entries, values, paged)
  }

  return {
    prepare(ordinal, fields, strings) {
      paged?.read(ordinal)
      if (strings !== undefined) {
        segment.surfaces = strings.surfaces
        segment.spellings = strings.spellings
        segment.spellingTokens = strings.spellingTokens
        segment.partialFields = strings.partialFields
        state.removedSurfaces = strings.removedSurfaces
        state.removedSpellings = strings.removedSpellings
      }
      const count = prepareCount(ordinal, fields)
      if (count < 0) corrupted(-count)
      const kinds = entries.slice(0, count * 2)
      const replacements = values.slice(0, count)
      const header = state.pendingHeader
      const heldDocuments = header[PENDING_DOCUMENTS]
      const heldTokens = header[PENDING_TOKENS]
      const heldUnits = header[PENDING_UNITS]
      const targets = [state.tombstones, state.tombstoneCount, header]
      return () => {
        if (
          header[PENDING_DOCUMENTS] !== heldDocuments ||
          header[PENDING_TOKENS] !== heldTokens ||
          header[PENDING_UNITS] !== heldUnits
        )
          corrupted(0)
        for (let at = 0; at < count; at++)
          targets[kinds[at * 2] - FIRST_PREPARED_KIND][kinds[at * 2 + 1]] = replacements[at]
      }
    },
    pending: () => !pendingSettled(state),
    settle,
    bytes: () =>
      state.pendingHeader.byteLength +
      state.pendingDocuments.byteLength +
      state.pendingTokens.byteLength +
      state.pendingUnits.byteLength,
  }
}
