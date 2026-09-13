import type { VectorMetric } from './brute-force'
import { computeCalibrationBounds } from './scalar-quantization-calibration'
import type { QuantizedQuery, ScalarQuantizer, SerializedSQ8 } from './scalar-quantization-types'
import { openSharedQuantizer, type SharedQuantizerView } from './scalar-quantization-view'
import type { VectorStore } from './vector-store'

/**
 * Builds the quantizer of one vector field over the store that holds its
 * vectors, writing each vector's codes beside the vector in the store's
 * shared blocks.
 *
 * @param dimensions The number of components per vector.
 * @param store The store holding the field's vectors.
 * @returns The quantizer.
 *
 * @internal
 */
export function createScalarQuantizer(dimensions: number, store: VectorStore): ScalarQuantizer {
  let opened: SharedQuantizerView | null = null

  function shared(): SharedQuantizerView | null {
    if (opened === null && store.dimension === dimensions) opened = openSharedQuantizer(store.view)
    return opened
  }

  function requireShared(): SharedQuantizerView {
    const view = shared()
    if (view === null) throw new Error('The vector store holds no vector for the quantizer to work on')
    return view
  }

  function ordinalOf(docId: string): number {
    const ordinal = store.getOrdinal(docId)
    if (ordinal === undefined) {
      throw new Error(`Cannot quantize "${docId}": the vector store holds no vector for it`)
    }
    return ordinal
  }

  function calibrateFromVectors(vectors: Iterable<Float32Array>): void {
    const bounds = computeCalibrationBounds(vectors, dimensions)
    if (bounds === null) return
    requireShared().writeCalibration(bounds.alpha, bounds.offset)
  }

  function isOutsideBounds(view: SharedQuantizerView, vector: Float32Array): boolean {
    const { alpha, offset } = view.constants()
    const currentMax = offset + alpha * 255
    for (let d = 0; d < dimensions; d++) {
      if (vector[d] < offset || vector[d] > currentMax) return true
    }
    return false
  }

  return {
    get dimensions() {
      return dimensions
    },

    get size() {
      return shared()?.size ?? 0
    },

    get calibration() {
      return shared()?.calibration ?? null
    },

    isCalibrated: () => shared()?.isCalibrated() ?? false,

    calibrate(vectors) {
      calibrateFromVectors(vectors)
    },

    needsRecalibration(vector) {
      const view = shared()
      if (view === null || !view.isCalibrated()) return false
      return isOutsideBounds(view, vector)
    },

    recalibrateAll(vectors) {
      const collected: Array<[string, Float32Array]> = []
      const rawVectors: Float32Array[] = []
      for (const pair of vectors) {
        collected.push(pair)
        rawVectors.push(pair[1])
      }
      if (collected.length === 0) return
      calibrateFromVectors(rawVectors)
      const view = requireShared()
      view.resetCodes()
      for (const [docId, vector] of collected) view.writeCodes(ordinalOf(docId), vector)
    },

    quantize(docId, vector) {
      const ordinal = ordinalOf(docId)
      const view = requireShared()
      if (!view.isCalibrated()) calibrateFromVectors([vector])
      view.writeCodes(ordinal, vector)
    },

    remove(docId) {
      const ordinal = store.getOrdinal(docId)
      if (ordinal !== undefined) shared()?.clearCodes(ordinal)
    },

    removeOrdinal(ordinal) {
      shared()?.clearCodes(ordinal)
    },

    getQuantized(docId) {
      const view = shared()
      const ordinal = store.getOrdinal(docId)
      if (view === null || ordinal === undefined || !view.holdsOrdinal(ordinal)) return undefined
      return view.codesAt(ordinal)
    },

    prepareQuery: query => shared()?.prepareQuery(query) ?? null,

    distanceFromPrepared(prepared: QuantizedQuery, docId: string, metric: VectorMetric) {
      const view = shared()
      const ordinal = store.getOrdinal(docId)
      if (view === null || ordinal === undefined) return Number.POSITIVE_INFINITY
      return view.distanceFromPreparedByOrdinal(prepared, ordinal, metric)
    },

    distanceFromPreparedByOrdinal: (prepared, ordinal, metric) =>
      shared()?.distanceFromPreparedByOrdinal(prepared, ordinal, metric) ?? Number.POSITIVE_INFINITY,

    prepareQueryArena: query => shared()?.prepareQueryArena(query) ?? null,

    distanceFromArena: (prepared, ordinal, metric) =>
      shared()?.distanceFromArena(prepared, ordinal, metric) ?? Number.POSITIVE_INFINITY,

    hasOrdinal: ordinal => shared()?.holdsOrdinal(ordinal) ?? false,

    restoreCalibration(alpha, offset) {
      requireShared().writeCalibration(alpha, offset)
    },

    restoreEntry(docId, quantized, sum, sumSq) {
      requireShared().restoreCodes(ordinalOf(docId), quantized, sum, sumSq)
    },

    serialize(): SerializedSQ8 {
      const view = shared()
      const serializedVectors: Record<string, number[]> = {}
      const serializedSums: Record<string, number> = {}
      const serializedSumSqs: Record<string, number> = {}
      if (view !== null) {
        for (const [docId] of store.entries()) {
          const ordinal = store.getOrdinal(docId)
          if (ordinal === undefined || !view.holdsOrdinal(ordinal)) continue
          serializedVectors[docId] = Array.from(view.codesAt(ordinal))
          serializedSums[docId] = view.codeSumAt(ordinal)
          serializedSumSqs[docId] = view.codeSumSqAt(ordinal)
        }
      }
      const calibration = view?.calibration ?? null
      return {
        alpha: calibration?.alpha ?? 0,
        offset: calibration?.offset ?? 0,
        quantizedVectors: serializedVectors,
        vectorSums: serializedSums,
        vectorSumSqs: serializedSumSqs,
      }
    },

    clear() {
      const view = shared()
      if (view === null) return
      view.resetCodes()
      view.resetCalibration()
    },
  }
}
