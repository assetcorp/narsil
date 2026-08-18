import { createHNSWIndex, type HNSWIndex, type HNSWSnapshot } from './hnsw'
import { createScalarQuantizer } from './scalar-quantization'
import type { ScalarQuantizerCalibration } from './scalar-quantization-types'
import { createVectorStore, type VectorStore, type VectorStoreSnapshot } from './vector-store'

/**
 * One vector field's searchable state in the form the engine clones to a
 * worker, used where the runtime cannot share memory.
 *
 * @internal
 */
export interface WorkerCopySnapshot {
  /** Each vector carries this many components. */
  dimension: number
  /** The worker rebuilds a quantizer when this reads `sq8`. */
  quantization: 'sq8' | 'none'
  /**
   * The constants the calling thread quantizes with, carried so that the worker
   * derives the same codes rather than recalibrating over a set that a delete
   * has already narrowed.
   */
  calibration: ScalarQuantizerCalibration | null
  /** This holds every vector and the document id at each ordinal. */
  store: VectorStoreSnapshot
  /** This holds the built graph. */
  graph: HNSWSnapshot
  /** These documents have been deleted and must not be returned. */
  tombstones: string[]
}

export interface WorkerCopy {
  readonly store: VectorStore
  readonly graph: HNSWIndex
  readonly tombstones: ReadonlySet<string>
}

export function restoreWorkerCopy(snapshot: WorkerCopySnapshot): WorkerCopy {
  const store = createVectorStore()
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

  return { store, graph, tombstones }
}
