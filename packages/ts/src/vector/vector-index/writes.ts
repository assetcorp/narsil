import { ErrorCodes, NarsilError } from '../../errors'
import { coldInsert, coldRemove } from './cold'
import { handOverBuildTurns, threadsHoldCurrentLayout, type VectorIndexState } from './shared'
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

  function applyInsert(docId: string, vector: Float32Array, partitionId?: number): void {
    handOverBuildTurns(state)
    const previous = state.store.getOrdinal(docId)
    if (previous !== undefined && holdsThisVectorAlready(docId, previous, vector)) {
      if (partitionId !== undefined && state.store.partitionOfOrdinal(previous) !== partitionId) {
        noteWrite(state)
        state.store.setPartition(docId, partitionId)
      }
      return
    }
    noteWrite(state)
    state.tombstones.delete(docId)
    const graphHoldsPrevious =
      previous !== undefined &&
      ((state.hnsw?.holdsNode(previous) ?? false) || (state.freshGraph?.holdsNode(previous) ?? false))
    state.store.insert(docId, vector, partitionId, graphHoldsPrevious)
    if (previous !== undefined) {
      state.hnsw?.markTombstoneOrdinal(previous)
      state.freshGraph?.markTombstoneOrdinal(previous)
      if (!graphHoldsPrevious) state.osq?.removeOrdinal(previous)
    }
    state.buffer.add(docId)
    state.pendingLocations.delete(docId)
    if (!threadsHoldCurrentLayout(state)) scheduleWorkerCopyLoad(state)
  }

  function applyRemove(docId: string): void {
    handOverBuildTurns(state)
    if (!state.store.has(docId)) return
    noteWrite(state)
    state.tombstones.add(docId)
    state.buffer.delete(docId)
    state.pendingLocations.delete(docId)
    if (state.hnsw) {
      state.hnsw.markTombstone(docId)
    }
  }

  return {
    insert(docId, vector, partitionId) {
      validateDimension(vector)
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
