import { prepareFrozenRemoval } from '#platform/frozen-writes'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { REMOVAL_CHANGE_CAPACITY, REMOVAL_CHANGE_GROWTH } from './constants'

let scratchEntries = new Uint32Array(REMOVAL_CHANGE_CAPACITY * 2)
let scratchValues = new Float64Array(REMOVAL_CHANGE_CAPACITY)

export function prepareFrozenPublication(
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  ordinal: number,
  fields: readonly NativeFieldTokens[],
  synchroniseSurface?: (entry: number, removedCount: number) => void,
): () => void {
  let count = prepareFrozenRemoval(segment, state, ordinal, fields, scratchEntries, scratchValues)
  while (count === -3) {
    scratchValues = new Float64Array(scratchValues.length * REMOVAL_CHANGE_GROWTH)
    scratchEntries = new Uint32Array(scratchValues.length * 2)
    count = prepareFrozenRemoval(segment, state, ordinal, fields, scratchEntries, scratchValues)
  }
  if (count < 0)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The frozen segment refused a document removal', {
      status: -count,
    })
  const entries = scratchEntries.slice(0, count * 2)
  const values = scratchValues.slice(0, count)
  const targets = [
    state.removedDocuments,
    state.removedOccurrences,
    state.removedSurfaces,
    state.removedSpellings,
    state.tombstones,
    state.tombstoneCount,
  ]
  return () => {
    for (let at = 0; at < count; at++) {
      const target = entries[at * 2]
      if (target === 2) synchroniseSurface?.(entries[at * 2 + 1], values[at])
      targets[target][entries[at * 2 + 1]] = values[at]
    }
  }
}
