import { ErrorCodes, NarsilError } from '../../errors'
import { createHNSWIndex, type SerializedHNSWGraph } from '../hnsw'
import { deserializeScalarQuantizer, type SerializedSQ8 } from '../scalar-quantization'
import type { VectorIndexPayload, VectorIndexState } from './shared'

export function serialize(state: VectorIndexState): VectorIndexPayload {
  const vectors: Array<{ docId: string; vector: number[] }> = []
  for (const [docId, entry] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    vectors.push({ docId, vector: Array.from(entry.vector) })
  }

  const graphs: SerializedHNSWGraph[] = []
  if (state.hnsw) {
    graphs.push(state.hnsw.serialize())
  }

  let sq8Data: SerializedSQ8 | null = null
  if (state.sq8?.isCalibrated() && state.sq8.size > 0) {
    sq8Data = state.sq8.serialize()
  }

  return {
    fieldName: state.fieldName,
    dimension: state.dimension,
    vectors,
    graphs,
    sq8: sq8Data,
  }
}

export function deserialize(state: VectorIndexState, payload: VectorIndexPayload): void {
  if (payload.dimension !== state.dimension) {
    throw new NarsilError(
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      `Payload dimension ${payload.dimension} does not match index dimension ${state.dimension}`,
      { expected: state.dimension, received: payload.dimension },
    )
  }

  for (const entry of payload.vectors) {
    if (entry.vector.length !== state.dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Vector for doc "${entry.docId}" has dimension ${entry.vector.length}, expected ${state.dimension}`,
        { docId: entry.docId, expected: state.dimension, received: entry.vector.length },
      )
    }
  }

  state.store.clear()
  state.tombstones.clear()
  state.buffer.clear()
  if (state.hnsw) {
    state.hnsw.clear()
    state.hnsw = null
  }
  if (state.sq8) {
    state.sq8.clear()
  }

  for (const entry of payload.vectors) {
    state.store.insert(entry.docId, new Float32Array(entry.vector))
  }

  if (payload.sq8) {
    if (state.quantizationMode === 'sq8') {
      state.sq8 = deserializeScalarQuantizer(payload.sq8, state.dimension)
    }
  }

  if (payload.graphs.length > 0) {
    const graphData = payload.graphs[0]
    const restoredHnsw = createHNSWIndex(
      state.dimension,
      state.store,
      {
        m: graphData.m ?? state.hnswConfig?.m,
        efConstruction: graphData.efConstruction ?? state.hnswConfig?.efConstruction,
        metric: graphData.metric ?? state.hnswConfig?.metric,
      },
      state.sq8 ?? undefined,
    )
    restoredHnsw.deserialize(graphData)
    state.hnsw = restoredHnsw

    for (let i = 1; i < payload.graphs.length; i++) {
      const additionalGraph = payload.graphs[i]
      for (const [nodeDocId] of additionalGraph.nodes) {
        if (!restoredHnsw.has(nodeDocId) && state.store.has(nodeDocId)) {
          restoredHnsw.insertNode(nodeDocId)
        }
      }
    }

    for (const [docId] of state.store.entries()) {
      if (state.tombstones.has(docId)) continue
      if (!restoredHnsw.has(docId)) {
        state.buffer.add(docId)
      }
    }

    if (state.buffer.size > restoredHnsw.size) {
      state.hnsw.clear()
      state.hnsw = null
      state.buffer.clear()
      for (const [docId] of state.store.entries()) {
        if (state.tombstones.has(docId)) continue
        state.buffer.add(docId)
      }
    }
  } else {
    for (const [docId] of state.store.entries()) {
      if (state.tombstones.has(docId)) continue
      state.buffer.add(docId)
    }
  }
}
