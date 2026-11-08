import { prepareFrozenRemoval } from '#platform/frozen-writes'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { REMOVAL_CHANGE_CAPACITY, REMOVAL_CHANGE_GROWTH } from './constants'

export function prepareFrozenPublication(
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  ordinal: number,
  fields: readonly NativeFieldTokens[],
): () => void {
  let capacity = REMOVAL_CHANGE_CAPACITY
  let entries = new Uint32Array(capacity * 2)
  let values = new Float64Array(capacity)
  let count = prepareFrozenRemoval(segment, state, ordinal, fields, entries, values)
  while (count === -3) {
    capacity *= REMOVAL_CHANGE_GROWTH
    entries = new Uint32Array(capacity * 2)
    values = new Float64Array(capacity)
    count = prepareFrozenRemoval(segment, state, ordinal, fields, entries, values)
  }
  if (count < 0)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The frozen segment refused a document removal', {
      status: -count,
    })
  const targets = [
    state.removedDocuments,
    state.removedOccurrences,
    state.removedSurfaces,
    state.removedSpellings,
    state.tombstones,
    state.tombstoneCount,
  ]
  return () => {
    for (let at = 0; at < count; at++) targets[entries[at * 2]][entries[at * 2 + 1]] = values[at]
  }
}
