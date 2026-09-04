import { compareCodePoints } from '../../core/ordering'
import { WASM_PAGE_BYTES } from '../constants'
import type { HNSWIndex } from '../hnsw'
import { ABSENT_DOCUMENT_RANK } from '../hnsw/search'
import type { ScalarQuantizer } from '../scalar-quantization-types'
import type { VectorStore } from '../vector-store'
import { computeSharedGenerationLayout } from './layout'
import type { SharedGenerationSnapshot } from './types'

/**
 * The parts of a vector field a freeze reads.
 *
 * @internal
 */
export interface SharedGenerationSource {
  /** Each vector carries this many components. */
  dimension: number
  /** The store holding every vector and document id. */
  store: VectorStore
  /** The built graph, or null while none exists. */
  hnsw: HNSWIndex | null
  /** The quantizer, or null when quantisation is off. */
  quantizer: ScalarQuantizer | null
  /** The field's configured quantisation mode. */
  quantization: 'sq8' | 'none'
}

function sharedInt8(source: Int8Array): Int8Array {
  const copy = new Int8Array(new SharedArrayBuffer(source.length))
  copy.set(source)
  return copy
}

function sharedInt32(source: Int32Array): Int32Array {
  const copy = new Int32Array(new SharedArrayBuffer(source.length * 4))
  copy.set(source)
  return copy
}

function sharedUint8(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new SharedArrayBuffer(source.length))
  copy.set(source)
  return copy
}

function buildRankTable(store: VectorStore, slots: number): Uint32Array {
  const rank = new Uint32Array(new SharedArrayBuffer(slots * 4))
  rank.fill(ABSENT_DOCUMENT_RANK)

  const pairs: Array<{ ord: number; docId: string }> = []
  for (let ord = 0; ord < slots; ord++) {
    const docId = store.docIdForOrdinal(ord)
    if (docId === undefined) continue
    pairs.push({ ord, docId })
  }
  pairs.sort((a, b) => compareCodePoints(a.docId, b.docId))
  for (let position = 0; position < pairs.length; position++) {
    rank[pairs[position].ord] = position
  }
  return rank
}

/**
 * Freezes one shared copy of a vector field: one shared memory holding the
 * vectors and codes, shared buffers holding the graph and per-ordinal data,
 * and a rank table standing in for the document id strings.
 *
 * Every worker searches this one copy instead of holding its own, and any
 * later write to the field invalidates it rather than mutating it.
 *
 * @param source The vector field state to freeze.
 * @param workerSlots The number of per-worker scratch slot pairs to reserve.
 * @returns The frozen copy, or null when the runtime lacks shared memory,
 * the field holds no built graph, or the data cannot fit one 32-bit memory.
 *
 * @internal
 */
export function freezeSharedGeneration(
  source: SharedGenerationSource,
  workerSlots: number,
): SharedGenerationSnapshot | null {
  if (typeof SharedArrayBuffer !== 'function') return null
  const hnsw = source.hnsw
  if (!hnsw) return null

  const slots = source.store.slots
  const quantizer = source.quantizer
  const withCodes =
    source.quantization === 'sq8' && quantizer !== null && quantizer.isCalibrated() && quantizer.size > 0
  const calibration = withCodes && quantizer !== null ? quantizer.calibration : null

  const layout = computeSharedGenerationLayout(source.dimension, slots, workerSlots, withCodes)
  if (layout === null) return null

  let memory: WebAssembly.Memory
  try {
    const pages = layout.totalBytes / WASM_PAGE_BYTES
    memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true })
  } catch {
    return null
  }

  const vectors = new Float32Array(memory.buffer, layout.vectorsOffset, slots * source.dimension)
  const magnitudes = new Float64Array(new SharedArrayBuffer(slots * 8))
  source.store.copySnapshotInto(vectors, magnitudes)

  let codeSums: Float64Array = new Float64Array(0)
  let codeMagnitudes: Float64Array = new Float64Array(0)
  let codePresent: Uint8Array = new Uint8Array(0)
  if (withCodes && quantizer !== null) {
    const codes = new Uint8Array(memory.buffer, layout.codesOffset, slots * source.dimension)
    codeSums = new Float64Array(new SharedArrayBuffer(slots * 8))
    const codeSumSqs = new Float64Array(slots)
    codeMagnitudes = new Float64Array(new SharedArrayBuffer(slots * 8))
    codePresent = new Uint8Array(new SharedArrayBuffer(slots))
    quantizer.copyStateInto(codes, codeSums, codeSumSqs, codeMagnitudes, codePresent)
  }

  const graph = hnsw.exportSnapshot()

  return {
    dimension: source.dimension,
    quantization: withCodes ? 'sq8' : 'none',
    calibration,
    memory,
    layout,
    magnitudes,
    codeSums,
    codeMagnitudes,
    codePresent,
    graph: {
      ...graph,
      adjacency: {
        ...graph.adjacency,
        nodeLevels: sharedInt8(graph.adjacency.nodeLevels),
        level0: sharedInt32(graph.adjacency.level0),
        upperBase: sharedInt32(graph.adjacency.upperBase),
        upper: sharedInt32(graph.adjacency.upper),
      },
      tombstones: sharedUint8(graph.tombstones),
    },
    rankByOrdinal: buildRankTable(source.store, slots),
  }
}
