import { importAdjacency } from '../hnsw/adjacency'
import { ABSENT_DOCUMENT_RANK } from '../hnsw/search'
import type { HNSWSearchState } from '../hnsw/shared'
import { createHNSWWorkspace } from '../hnsw/workspace'
import {
  arenaQuantizedDistance,
  deriveSq8Constants,
  quantizedMagnitude,
  quantizeVectorInto,
  scalarQuantizedDistance,
} from '../scalar-quantization-math'
import type { QuantizerSearchReader } from '../scalar-quantization-types'
import { arenaFloat32Distance, createSharedArenaSimd } from '../simd'
import type { VectorSearchReader } from '../vector-store'
import type { SharedGenerationSnapshot } from './types'

/**
 * One worker's handle on a frozen shared copy: the search state over the
 * shared views and the rank table that stands in for document ids.
 *
 * @internal
 */
export interface SharedWorkerCopy {
  /** The state {@link searchOrdinals} runs against. */
  searchState: HNSWSearchState
  /** Each ordinal's document id rank in code point order. */
  rankByOrdinal: Uint32Array
}

function createVectorReader(
  snapshot: SharedGenerationSnapshot,
  simd: ReturnType<typeof createSharedArenaSimd>,
  scratchSlot: number,
): VectorSearchReader {
  const { layout, magnitudes, rankByOrdinal } = snapshot
  const { dimension, slots } = layout
  const vectors = new Float32Array(snapshot.memory.buffer, layout.vectorsOffset, slots * dimension)
  const scratchByteOffset = scratchSlot * layout.float32ScratchStride
  const scratch = simd ? new Float32Array(snapshot.memory.buffer, scratchByteOffset, dimension) : null

  const holdsDocument = (ordinal: number): boolean =>
    ordinal >= 0 && ordinal < slots && rankByOrdinal[ordinal] !== ABSENT_DOCUMENT_RANK

  return {
    entryForOrdinal(ordinal) {
      if (!holdsDocument(ordinal)) return undefined
      const base = ordinal * dimension
      return { vector: vectors.subarray(base, base + dimension), magnitude: magnitudes[ordinal] }
    },

    prepareQueryArena(query) {
      if (!simd || !scratch || query.length !== dimension) return null
      scratch.set(query, 0)
      return { magnitude: simd.magnitude(scratchByteOffset, dimension) }
    },

    distanceFromArena(prepared, ordinal, metric) {
      if (!simd || !holdsDocument(ordinal)) return Number.POSITIVE_INFINITY
      const byteOffset = layout.vectorsOffset + ordinal * dimension * 4
      return arenaFloat32Distance(
        simd,
        scratchByteOffset,
        byteOffset,
        dimension,
        metric,
        prepared.magnitude,
        magnitudes[ordinal],
      )
    },
  }
}

function createQuantizerReader(
  snapshot: SharedGenerationSnapshot,
  simd: ReturnType<typeof createSharedArenaSimd>,
  scratchSlot: number,
): QuantizerSearchReader | undefined {
  if (snapshot.quantization !== 'sq8' || snapshot.calibration === null) return undefined

  const { layout, codeSums, codeMagnitudes, codePresent } = snapshot
  const { dimension, slots } = layout
  const constants = deriveSq8Constants(snapshot.calibration.alpha, snapshot.calibration.offset, dimension)
  const codes = new Uint8Array(snapshot.memory.buffer, layout.codesOffset, slots * dimension)
  const scratchByteOffset = layout.codeScratchOffset + scratchSlot * layout.codeScratchStride
  const scratch = simd ? new Uint8Array(snapshot.memory.buffer, scratchByteOffset, dimension) : null

  let liveCodes = 0
  for (let ordinal = 0; ordinal < codePresent.length; ordinal++) {
    if (codePresent[ordinal] === 1) liveCodes++
  }

  const holdsCodes = (ordinal: number): boolean => ordinal >= 0 && ordinal < slots && codePresent[ordinal] === 1

  return {
    get size() {
      return liveCodes
    },

    isCalibrated: () => true,

    prepareQuery(query) {
      const quantized = new Uint8Array(dimension)
      const { sum, sumSq } = quantizeVectorInto(quantized, query, dimension, constants)
      return { quantized, sum, sumSq, magnitude: quantizedMagnitude(constants, sumSq, sum) }
    },

    distanceFromPreparedByOrdinal(prepared, ordinal, metric) {
      if (!holdsCodes(ordinal)) return Number.POSITIVE_INFINITY
      return scalarQuantizedDistance(
        codes,
        codeSums,
        codeMagnitudes,
        dimension,
        constants,
        prepared.quantized,
        prepared.sum,
        prepared.magnitude,
        ordinal,
        metric,
      )
    },

    prepareQueryArena(query) {
      if (!simd || !scratch) return null
      const { sum, sumSq } = quantizeVectorInto(scratch, query, dimension, constants)
      return { sum, sumSq, magnitude: quantizedMagnitude(constants, sumSq, sum) }
    },

    distanceFromArena(prepared, ordinal, metric) {
      if (!simd || !holdsCodes(ordinal)) return Number.POSITIVE_INFINITY
      return arenaQuantizedDistance(
        simd,
        scratchByteOffset,
        layout.codesOffset + ordinal * dimension,
        dimension,
        constants,
        prepared.sum,
        prepared.magnitude,
        codeSums[ordinal],
        codeMagnitudes[ordinal],
        metric,
      )
    },
  }
}

/**
 * Opens a frozen shared copy on the current thread, binding this thread's own
 * scratch slot and visited array so concurrent searches stay independent.
 *
 * @param snapshot The frozen copy to open.
 * @param scratchSlot This thread's scratch slot index, below the layout's
 * worker slot count.
 * @returns The search state and rank table for {@link searchOrdinals}.
 *
 * @internal
 */
export function openSharedWorkerCopy(snapshot: SharedGenerationSnapshot, scratchSlot: number): SharedWorkerCopy {
  if (scratchSlot < 0 || scratchSlot >= snapshot.layout.workerSlots) {
    throw new Error(`Scratch slot ${scratchSlot} is outside the ${snapshot.layout.workerSlots} reserved slots`)
  }

  const simd = createSharedArenaSimd(snapshot.memory)
  const adjacency = importAdjacency(snapshot.graph.adjacency)
  const capacity = Math.max(snapshot.graph.capacity, adjacency.capacity)

  const searchState: HNSWSearchState = {
    dimension: snapshot.dimension,
    store: createVectorReader(snapshot, simd, scratchSlot),
    quantizer: createQuantizerReader(snapshot, simd, scratchSlot),
    adjacency,
    tombstones: snapshot.graph.tombstones,
    tombstoneCount: snapshot.graph.tombstoneCount,
    nodeCount: snapshot.graph.nodeCount,
    capacity,
    visited: new Uint32Array(capacity),
    visitStamp: 0,
    entryPointOrd: snapshot.graph.entryPointOrd,
    topLayer: snapshot.graph.topLayer,
    workspace: createHNSWWorkspace(),
  }

  return { searchState, rankByOrdinal: snapshot.rankByOrdinal }
}
