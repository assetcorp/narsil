import { admitsBackgroundBytes, noteWaitingForMemory } from '../../runtime/background-memory'
import { chargeHeapBytes } from '../../runtime/thread-heap'
import type { VectorIndexState } from './shared'

export function admitShuffledRebuild(state: VectorIndexState): boolean {
  const bytes = state.hnsw?.graphBytes ?? 0
  if (!admitsBackgroundBytes(bytes)) {
    state.waitingForMemory = true
    noteWaitingForMemory(state, { indexName: state.indexName, fieldName: state.fieldName })
    return false
  }
  stopWaitingForMemory(state)
  chargeHeapBytes(bytes - state.rebuildChargeBytes)
  state.rebuildChargeBytes = bytes
  return true
}

export function stopWaitingForMemory(state: VectorIndexState): void {
  if (!state.waitingForMemory) return
  state.waitingForMemory = false
  noteWaitingForMemory(state, null)
}

export function releaseRebuildCharge(state: VectorIndexState): void {
  chargeHeapBytes(-state.rebuildChargeBytes)
  state.rebuildChargeBytes = 0
}

export function releaseMemoryCharges(state: VectorIndexState): void {
  releaseRebuildCharge(state)
  stopWaitingForMemory(state)
  if (state.rebuildWaitTimer !== null) clearTimeout(state.rebuildWaitTimer)
  state.rebuildWaitTimer = null
}
