import { adjacencySlots } from './adjacency'
import { createSharedGraphHandles, graphShapeOf } from './handles'
import { lockGraphExclusive, unlockGraphExclusive } from './locks'
import { compactTombstones, markTombstone } from './mutation'
import { type HNSWGraphState, isTombstoned, nodeExists } from './shared'
import { exportSnapshot, restoreSnapshot } from './snapshot'
import { openGraphState } from './state'

export const NO_NUMBER = -1

function savesNode(numberOfOrdinal: Int32Array, ordinal: number): boolean {
  return ordinal < numberOfOrdinal.length && numberOfOrdinal[ordinal] !== NO_NUMBER
}

function unsavedNodes(state: HNSWGraphState, numberOfOrdinal: Int32Array): number[] {
  const unsaved: number[] = []
  const slots = adjacencySlots(state.adjacency)
  for (let ordinal = 0; ordinal < slots; ordinal++) {
    if (!nodeExists(state, ordinal)) continue
    if (isTombstoned(state, ordinal) || !savesNode(numberOfOrdinal, ordinal)) unsaved.push(ordinal)
  }
  return unsaved
}

export function graphToSave(state: HNSWGraphState, numberOfOrdinal: Int32Array): HNSWGraphState {
  const unsaved = unsavedNodes(state, numberOfOrdinal)
  if (unsaved.length === 0) return state
  const handles = createSharedGraphHandles(graphShapeOf(state.header))
  const copy = openGraphState(handles, state.dimension, state.store, state.quantizer, state.locks.threadSlot)
  restoreSnapshot(copy, exportSnapshot(state))
  for (const ordinal of unsaved) markTombstone(copy, ordinal)
  lockGraphExclusive(copy.locks)
  try {
    compactTombstones(copy)
  } finally {
    unlockGraphExclusive(copy.locks)
  }
  return copy
}
