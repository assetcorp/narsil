import { ErrorCodes, handOverBuildTurns, NarsilError, threadsHoldCurrentLayout } from '#platform/vector-host'
import { coldInsert, coldRemove } from './cold'
import { afterGraphPass } from './graph-pass'
import { noteSearchedDocWritten } from './search-writes'
import type { VectorIndexState } from './shared'
import { noteWrite, scheduleWorkerCopyLoad } from './worker-copies'

export interface VectorWrites {
  insert(docId: string, vector: Float32Array, partitionId?: number): void
  remove(docId: string): void
}

export function createVectorWrites(state: VectorIndexState): VectorWrites {
  function validateDimension(vector: Float32Array): void {
    if (vector.length !== state.dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Vector dimension mismatch: expected ${state.dimension}, got ${vector.length}`,
        { expected: state.dimension, received: vector.length },
      )
    }
  }

  function heldVectorOrUndefinedWhereItsFileFailsToRead(ordinal: number): Float32Array | undefined {
    try {
      return state.store.entryForOrdinal(ordinal)?.vector
    } catch {
      return undefined
    }
  }

  function holdsThisVectorAlready(docId: string, ordinal: number, vector: Float32Array): boolean {
    if (state.tombstones.has(docId)) return false
    const held = heldVectorOrUndefinedWhereItsFileFailsToRead(ordinal)
    if (held === undefined) return false
    for (let i = 0; i < vector.length; i++) if (held[i] !== vector[i]) return false
    return true
  }

  function forgetRetiredFlags(): void {
    const oldestPin = state.store.oldestPin()
    state.buffer.forgetRetired(ordinal => state.store.mayFreeOrdinal(ordinal, oldestPin))
  }

  function applyInsert(docId: string, vector: Float32Array, partitionId?: number): void {
    handOverBuildTurns(state)
    const previous = state.store.getOrdinal(docId)
    if (previous !== undefined && holdsThisVectorAlready(docId, previous, vector)) {
      if (partitionId !== undefined && state.store.partitionOfOrdinal(previous) !== partitionId) {
        noteWrite(state)
        noteSearchedDocWritten(state, docId)
        state.store.setPartition(docId, partitionId)
      }
      return
    }
    noteWrite(state)
    noteSearchedDocWritten(state, docId)
    state.tombstones.delete(docId)
    const graphHoldsPrevious =
      previous !== undefined &&
      ((state.hnsw?.holdsNode(previous) ?? false) ||
        (state.freshGraph?.holdsNode(previous) ?? false) ||
        (state.growingCopy?.holdsNode(previous) ?? false))
    state.store.insert(docId, vector, partitionId, graphHoldsPrevious)
    if (previous !== undefined) {
      const graph = state.hnsw
      const freshGraph = state.freshGraph
      const growingCopy = state.growingCopy
      afterGraphPass(state, () => {
        graph?.markTombstoneOrdinal(previous)
        freshGraph?.markTombstoneOrdinal(previous)
        growingCopy?.markTombstoneOrdinal(previous)
      })
      if (!graphHoldsPrevious) state.osq?.removeOrdinal(previous)
    }
    state.buffer.add(docId)
    if (state.buffer.retiredCount !== 0) forgetRetiredFlags()
    state.pendingLocations.delete(docId)
    if (!threadsHoldCurrentLayout(state)) scheduleWorkerCopyLoad(state)
  }

  function applyRemove(docId: string): void {
    handOverBuildTurns(state)
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) return
    noteWrite(state)
    noteSearchedDocWritten(state, docId)
    state.tombstones.add(docId)
    state.store.retire(ordinal)
    state.buffer.retire(docId)
    if (state.buffer.retiredCount !== 0) forgetRetiredFlags()
    state.pendingLocations.delete(docId)
    const graph = state.hnsw
    const growingCopy = state.growingCopy
    afterGraphPass(state, () => {
      graph?.markTombstoneOrdinal(ordinal)
      growingCopy?.markTombstoneOrdinal(ordinal)
    })
  }

  return {
    insert(docId, vector, partitionId) {
      validateDimension(vector)
      for (const listener of state.writeListeners) listener(docId)
      const hold = state.cold
      if (hold === null) {
        applyInsert(docId, vector, partitionId)
        return
      }
      noteWrite(state)
      coldInsert(hold, docId, vector, partitionId)
      const held = vector.slice()
      hold.writes.push(() => applyInsert(docId, held, partitionId))
    },
    remove(docId) {
      for (const listener of state.writeListeners) listener(docId)
      const hold = state.cold
      if (hold === null) {
        applyRemove(docId)
        return
      }
      if (!coldRemove(hold, docId)) return
      noteWrite(state)
      hold.writes.push(() => applyRemove(docId))
    },
  }
}
