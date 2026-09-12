import { createHNSWIndex, type HNSWIndex, type HNSWSnapshot } from './hnsw'
import { createScalarQuantizer } from './scalar-quantization'
import type { ScalarQuantizerCalibration } from './scalar-quantization-types'
import { createVectorStore, type VectorStore, type VectorStoreSnapshot } from './vector-store'

/**
 * The engine clones one vector field's searchable state to a worker in this
 * form, which it uses where the runtime shares no memory.
 *
 * @internal
 */
export interface WorkerCopySnapshot {
  /** Every vector of the field has this many components. */
  dimension: number
  /** The worker rebuilds a quantizer when this reads `sq8`. */
  quantization: 'sq8' | 'none'
  /**
   * The calling thread quantizes with these constants, and the worker derives
   * the same codes from them, so it skips a recalibration over a set that a
   * delete has already narrowed.
   */
  calibration: ScalarQuantizerCalibration | null
  /** This holds every vector and the document id at each ordinal. */
  store: VectorStoreSnapshot
  /** This holds the built graph. */
  graph: HNSWSnapshot
  /** The worker leaves these deleted documents out of every result. */
  tombstones: string[]
}

export interface WorkerCopy {
  readonly store: VectorStore
  readonly graph: HNSWIndex
  readonly tombstones: ReadonlySet<string>
}

export function restoreWorkerCopy(snapshot: WorkerCopySnapshot): WorkerCopy {
  const store = createVectorStore({ dimension: snapshot.dimension, quantized: snapshot.quantization === 'sq8' })
  store.restoreSnapshot(snapshot.store)

  const tombstones = new Set(snapshot.tombstones)

  let quantizer = null
  if (snapshot.quantization === 'sq8') {
    const sq8 = createScalarQuantizer(snapshot.dimension, store)
    if (snapshot.calibration !== null) {
      sq8.restoreCalibration(snapshot.calibration.alpha, snapshot.calibration.offset)
    } else {
      const live: Float32Array[] = []
      for (const [docId, entry] of store.entries()) {
        if (tombstones.has(docId)) continue
        live.push(entry.vector)
      }
      sq8.calibrate(live)
    }
    for (const [docId, entry] of store.entries()) {
      if (tombstones.has(docId)) continue
      sq8.quantize(docId, entry.vector)
    }
    quantizer = sq8
  }

  const graph = createHNSWIndex(
    snapshot.dimension,
    store,
    { m: snapshot.graph.m, efConstruction: snapshot.graph.efConstruction, metric: snapshot.graph.metric },
    quantizer ?? undefined,
  )
  graph.restoreSnapshot(snapshot.graph)
  for (const docId of tombstones) graph.markTombstone(docId)

  return { store, graph, tombstones }
}
