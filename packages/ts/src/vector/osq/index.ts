import type { VectorMetric } from '../brute-force'
import type { VectorStore } from '../vector-store'
import type { OsqBits } from './quantize'
import { unpackLevels } from './record'
import type { OsqQuantizer } from './types'
import { openSharedQuantizer, type SharedQuantizerView } from './view'

export type { OsqBits, OsqCode } from './quantize'
export { osqBitsOf } from './quantize'
export type { OsqQuantizer, OsqQuery, QuantizerBuildReader, QuantizerSearchReader } from './types'

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

    calibrate(ordinals) {
      if (ordinals.length > 0) requireShared().calibrateFrom(ordinals)
    },

    quantize(docId) {
      const ordinal = ordinalOf(docId)
      const view = requireShared()
      if (!view.isCalibrated()) view.calibrateFrom(Int32Array.of(ordinal))
      view.writeCodes(ordinal)
    },

    writeCodes(ordinal) {
      shared()?.writeCodes(ordinal)
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

    recalibrate(ordinals) {
      if (ordinals.length === 0) return
      const view = requireShared()
      view.resetCodes()
      view.calibrateFrom(ordinals)
      view.writeCodesOf(ordinals)
    },

    prepareQuery: query => shared()?.prepareQuery(query) ?? null,

    distanceFromPreparedByOrdinal: (prepared, ordinal) =>
      shared()?.distanceFromPreparedByOrdinal(prepared, ordinal) ?? Number.POSITIVE_INFINITY,

    preparedDistance(prepared) {
      const view = shared()
      if (view === null) return () => Number.POSITIVE_INFINITY
      return view.preparedDistance(prepared)
    },

    pairDistance() {
      const view = shared()
      if (view === null) return () => Number.POSITIVE_INFINITY
      return view.pairDistance()
    },

    distanceBetweenOrdinals: (ordA, ordB) => shared()?.distanceBetweenOrdinals(ordA, ordB) ?? Number.POSITIVE_INFINITY,

    clear() {
      const view = shared()
      if (view === null) return
      view.resetCodes()
      view.resetCalibration()
    },
  }
}
