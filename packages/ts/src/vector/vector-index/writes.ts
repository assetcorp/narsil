import { ErrorCodes, handOverBuildTurns, NarsilError, threadsHoldCurrentLayout } from '#platform/vector-host'
import { coldInsert, coldRemove, coldRestore, requireRoomInHold, sameVector } from './cold-writes'
import { afterGraphPass } from './graph-pass'
import { forgetKeptOrdinal, keepRetiredOrdinal, keptOrdinalsOf } from './rollback-holds'
import { noteSearchedDocWritten } from './search-writes'
import type { VectorIndexState } from './shared'
import { noteWrite, scheduleWorkerCopyLoad } from './worker-copies'

export interface VectorWrites {
  insert(docId: string, vector: Float32Array, partitionId?: number): void
  restore(docId: string, vector: Float32Array, partitionId?: number): void
  requireRoomForNewVector(docId: string): void
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
    return held !== undefined && sameVector(held, vector)
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
    state.store.requireRoomFor(docId)
    noteWrite(state)
    noteSearchedDocWritten(state, docId)
    state.tombstones.delete(docId)
    const graphHoldsPrevious = previous !== undefined && graphsHoldNode(previous)
    if (previous !== undefined) keepRetiredOrdinal(state, docId, previous)
    state.store.insert(docId, vector, partitionId, graphHoldsPrevious)
    if (previous !== undefined) retireFromGraphs(previous, graphHoldsPrevious)
    finishPlacingInBuffer(docId)
  }

  function graphsHoldNode(ordinal: number): boolean {
    return (state.hnsw?.holdsNode(ordinal) ?? false) || (state.freshGraph?.holdsNode(ordinal) ?? false)
  }

  function retireFromGraphs(previous: number, graphHoldsPrevious: boolean): void {
    const graph = state.hnsw
    const freshGraph = state.freshGraph
    afterGraphPass(state, () => {
      graph?.markTombstoneOrdinal(previous)
      freshGraph?.markTombstoneOrdinal(previous)
    })
    if (!graphHoldsPrevious) state.osq?.removeOrdinal(previous)
  }

  function finishPlacingInBuffer(docId: string): void {
    state.buffer.add(docId)
    if (state.buffer.retiredCount !== 0) forgetRetiredFlags()
    state.pendingLocations.delete(docId)
    if (!threadsHoldCurrentLayout(state)) scheduleWorkerCopyLoad(state)
  }

  function keptOrdinalHolding(docId: string, vector: Float32Array): number | undefined {
    const kept = keptOrdinalsOf(state, docId)
    for (let at = kept.length - 1; at >= 0; at--) {
      const held = heldVectorOrUndefinedWhereItsFileFailsToRead(kept[at])
      if (held !== undefined && sameVector(held, vector)) return kept[at]
    }
    return undefined
  }

  function applyRestore(docId: string, vector: Float32Array, partitionId?: number): boolean {
    const ordinal = keptOrdinalHolding(docId, vector)
    if (ordinal === undefined) return false
    handOverBuildTurns(state)
    const current = state.store.getOrdinal(docId)
    if (current === ordinal && !state.tombstones.has(docId)) return true
    const previous = current === ordinal ? undefined : current
    const graphHoldsPrevious = previous !== undefined && graphsHoldNode(previous)
    if (!state.store.reclaim(docId, ordinal, partitionId, graphHoldsPrevious)) return false
    forgetKeptOrdinal(state, docId, ordinal)
    noteWrite(state)
    noteSearchedDocWritten(state, docId)
    state.tombstones.delete(docId)
    if (previous !== undefined) retireFromGraphs(previous, graphHoldsPrevious)
    const graph = state.hnsw
    const freshGraph = state.freshGraph
    afterGraphPass(state, () => {
      graph?.reviveOrdinal(ordinal)
      freshGraph?.reviveOrdinal(ordinal)
    })
    finishPlacingInBuffer(docId)
    return true
  }

  function applyRemove(docId: string): void {
    handOverBuildTurns(state)
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) return
    noteWrite(state)
    noteSearchedDocWritten(state, docId)
    state.tombstones.add(docId)
    keepRetiredOrdinal(state, docId, ordinal)
    state.store.retire(ordinal)
    state.buffer.retire(docId)
    if (state.buffer.retiredCount !== 0) forgetRetiredFlags()
    state.pendingLocations.delete(docId)
    const graph = state.hnsw
    if (graph !== null) afterGraphPass(state, () => graph.markTombstoneOrdinal(ordinal))
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
      const held = vector.slice()
      const keepsReplacedCopy = state.rollbackHolds.has(docId)
      if (coldInsert(hold, docId, held, partitionId, keepsReplacedCopy, () => applyInsert(docId, held, partitionId))) {
        noteWrite(state)
      }
    },
    restore(docId, vector, partitionId) {
      validateDimension(vector)
      for (const listener of state.writeListeners) listener(docId)
      const hold = state.cold
      if (hold === null) {
        if (!applyRestore(docId, vector, partitionId)) applyInsert(docId, vector, partitionId)
        return
      }
      if (coldRestore(hold, docId, vector)) {
        noteWrite(state)
        return
      }
      const held = vector.slice()
      if (coldInsert(hold, docId, held, partitionId, false, () => applyInsert(docId, held, partitionId))) {
        noteWrite(state)
      }
    },
    requireRoomForNewVector(docId) {
      if (state.cold === null) state.store.requireRoomFor(docId)
      else requireRoomInHold(state.cold, docId)
    },
    remove(docId) {
      for (const listener of state.writeListeners) listener(docId)
      const hold = state.cold
      if (hold === null) {
        applyRemove(docId)
        return
      }
      if (coldRemove(hold, docId, () => applyRemove(docId))) noteWrite(state)
    },
  }
}
