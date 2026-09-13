import type { VectorQuantizationMode } from '../types/schema'
import type { VectorMetric } from './brute-force'
import { createHNSWIndex, type HNSWIndex, type HNSWSnapshot } from './hnsw'
import { createOsqQuantizer, type OsqQuantizer, osqBitsOf } from './osq'
import { osqRecordBytes } from './osq/record'
import { createVectorStore, type VectorStore, type VectorStoreSnapshot } from './vector-store'

/**
 * The code records of one field copied out flat, which the engine sends to
 * a worker that shares no memory with it.
 *
 * @internal
 */
export interface WorkerCopyCodes {
  /** The centroid the quantizer takes every record against. */
  centroid: Float32Array
  /** This holds one record per ordinal, end to end. */
  records: Uint8Array
  /** This holds one byte per ordinal, which reads 1 where the ordinal holds a record. */
  present: Uint8Array
}

/**
 * The engine clones one vector field's searchable state to a worker in this
 * form, which it uses where the runtime shares no memory.
 *
 * @internal
 */
export interface WorkerCopySnapshot {
  /** Every vector of the field has this many components. */
  dimension: number
  /** The worker estimates from code records under any mode but `none`. */
  quantization: VectorQuantizationMode
  /** The quantizer takes the codes under this metric. */
  metric: VectorMetric
  /** The records the calling thread wrote, so the worker rewrites none, or null where the field holds no codes. */
  codes: WorkerCopyCodes | null
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

function restoreQuantizer(snapshot: WorkerCopySnapshot, store: VectorStore): OsqQuantizer | null {
  const bits = osqBitsOf(snapshot.quantization)
  if (bits === null || snapshot.codes === null) return null
  const quantizer = createOsqQuantizer(snapshot.dimension, bits, snapshot.metric, store)
  quantizer.restoreCentroid(snapshot.codes.centroid)
  const recordBytes = osqRecordBytes(snapshot.dimension, bits)
  for (let ordinal = 0; ordinal < snapshot.codes.present.length; ordinal++) {
    if (snapshot.codes.present[ordinal] !== 1) continue
    const docId = store.docIdForOrdinal(ordinal)
    if (docId === undefined) continue
    quantizer.restoreRecord(docId, snapshot.codes.records.subarray(ordinal * recordBytes, (ordinal + 1) * recordBytes))
  }
  return quantizer
}

export function restoreWorkerCopy(snapshot: WorkerCopySnapshot): WorkerCopy {
  const store = createVectorStore({ dimension: snapshot.dimension, codeBits: osqBitsOf(snapshot.quantization) })
  store.restoreSnapshot(snapshot.store)

  const tombstones = new Set(snapshot.tombstones)
  const quantizer = restoreQuantizer(snapshot, store)

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
