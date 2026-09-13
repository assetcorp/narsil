import type { VectorMetric } from '../brute-force'
import type { VectorStore } from '../vector-store'
import { type OsqBits, osqCentroid } from './quantize'
import { unpackLevels } from './record'
import type { OsqQuantizer } from './types'
import { openSharedQuantizer, type SharedQuantizerView } from './view'

export type { OsqBits, OsqCode } from './quantize'
export { osqBitsOf } from './quantize'
export type { OsqQuantizer, OsqQuery, QuantizerBuildReader, QuantizerSearchReader } from './types'

/**
 * Builds the quantiser of one vector field over the store that holds its
 * vectors, writing each vector's record into the store's shared code blocks.
 *
 * @param dimension The number of components per vector.
 * @param bits The bits each level of a document code holds.
 * @param metric The metric the quantiser takes the codes under.
 * @param store The store holding the field's vectors.
 * @returns The quantiser.
 *
 * @internal
 */
export function createOsqQuantizer(
  dimension: number,
  bits: OsqBits,
  metric: VectorMetric,
  store: VectorStore,
): OsqQuantizer {
  let opened: SharedQuantizerView | null = null

  function shared(): SharedQuantizerView | null {
    if (opened === null && store.dimension === dimension && store.handles.codeLayout !== null) {
      opened = openSharedQuantizer(store.view, store.handles.codeLayout, metric)
    }
    return opened
  }

  function requireShared(): SharedQuantizerView {
    const view = shared()
    if (view === null) throw new Error('The vector store holds no vector for the quantiser to work on')
    return view
  }

  function ordinalOf(docId: string): number {
    const ordinal = store.getOrdinal(docId)
    if (ordinal === undefined) {
      throw new Error(`Cannot quantise "${docId}": the vector store holds no vector for it`)
    }
    return ordinal
  }

  function calibrateFromVectors(vectors: Iterable<Float32Array>): boolean {
    const centroid = osqCentroid(vectors, dimension, metric)
    if (centroid === null) return false
    requireShared().writeCentroid(centroid)
    return true
  }

  return {
    dimension,
    bits,
    metric,

    get size() {
      return shared()?.size ?? 0
    },

    get centroid() {
      return shared()?.centroid ?? null
    },

    isCalibrated: () => shared()?.isCalibrated() ?? false,

    calibrate(vectors) {
      calibrateFromVectors(vectors)
    },

    quantize(docId, vector) {
      const ordinal = ordinalOf(docId)
      const view = requireShared()
      if (!view.isCalibrated()) calibrateFromVectors([vector])
      view.writeCodes(ordinal, vector)
    },

    writeCodes(ordinal, vector) {
      shared()?.writeCodes(ordinal, vector)
    },

    remove(docId) {
      const ordinal = store.getOrdinal(docId)
      if (ordinal !== undefined) shared()?.clearCodes(ordinal)
    },

    removeOrdinal(ordinal) {
      shared()?.clearCodes(ordinal)
    },

    hasOrdinal: ordinal => shared()?.holdsOrdinal(ordinal) ?? false,

    getLevels(docId) {
      const view = shared()
      const ordinal = store.getOrdinal(docId)
      if (view === null || ordinal === undefined || !view.holdsOrdinal(ordinal)) return undefined
      return unpackLevels(view.recordAt(ordinal), 0, dimension, bits)
    },

    recordOf(docId) {
      const view = shared()
      const ordinal = store.getOrdinal(docId)
      if (view === null || ordinal === undefined || !view.holdsOrdinal(ordinal)) return undefined
      return view.recordAt(ordinal)
    },

    restoreRecord(docId, record) {
      requireShared().restoreRecord(ordinalOf(docId), record)
    },

    restoreCentroid(centroid) {
      requireShared().writeCentroid(centroid)
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

    prepareQuery: query => shared()?.prepareQuery(query) ?? null,

    distanceFromPreparedByOrdinal: (prepared, ordinal) =>
      shared()?.distanceFromPreparedByOrdinal(prepared, ordinal) ?? Number.POSITIVE_INFINITY,

    distanceBetweenOrdinals: (ordA, ordB) => shared()?.distanceBetweenOrdinals(ordA, ordB) ?? Number.POSITIVE_INFINITY,

    clear() {
      const view = shared()
      if (view === null) return
      view.resetCodes()
      view.resetCalibration()
    },
  }
}
