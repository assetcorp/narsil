import type { VectorMetric } from './brute-force'
import {
  arenaQuantizedDistance,
  deriveSq8Constants,
  quantizedMagnitude,
  quantizeVectorInto,
  type Sq8Constants,
  scalarQuantizedDistance,
} from './scalar-quantization-math'
import type {
  ArenaQuery,
  QuantizedQuery,
  QuantizerSearchReader,
  ScalarQuantizerCalibration,
} from './scalar-quantization-types'
import { fixedView } from './shared-buffers/growable'
import { slotByteOffset } from './vector-store/blocks'
import { CALIBRATION_ALPHA, CALIBRATION_OFFSET, STORE_CALIBRATED, STORE_CODE_COUNT } from './vector-store/handles'
import type { SharedVectorStoreView } from './vector-store/view'

/**
 * This is one thread's reader and writer over a field's shared codes. The
 * thread measures quantised distances against the codes in place, and it
 * writes the codes of every vector it places in the graph.
 *
 * @internal
 */
export interface SharedQuantizerView extends QuantizerSearchReader {
  readonly calibration: ScalarQuantizerCalibration | null
  constants(): Sq8Constants
  holdsOrdinal(ordinal: number): boolean
  codesAt(ordinal: number): Uint8Array
  codeSumAt(ordinal: number): number
  codeSumSqAt(ordinal: number): number
  writeCodes(ordinal: number, vector: Float32Array): void
  restoreCodes(ordinal: number, quantized: Uint8Array, sum: number, sumSq: number): void
  clearCodes(ordinal: number): void
  writeCalibration(alpha: number, offset: number): void
  resetCalibration(): void
  resetCodes(): void
}

/**
 * Opens a field's shared codes on the current thread, over the vector view
 * the thread already holds.
 *
 * @param store The thread's view over the field's vectors.
 * @returns The quantiser view.
 *
 * @internal
 */
export function openSharedQuantizer(store: SharedVectorStoreView): SharedQuantizerView {
  const dimension = store.dimension
  let bound = store.handles
  let codeSums = fixedView(bound.codeSums, Float64Array)
  let codeSumSqs = fixedView(bound.codeSumSqs, Float64Array)
  let codeMagnitudes = fixedView(bound.codeMagnitudes, Float64Array)
  let codePresent = fixedView(bound.codePresent, Uint8Array)
  let cachedConstants: Sq8Constants = deriveSq8Constants(0, 0, dimension)
  let cachedAlpha = Number.NaN
  let cachedOffset = Number.NaN
  let queryCodes: Uint8Array | null = null

  function rebind(): void {
    bound = store.handles
    codeSums = fixedView(bound.codeSums, Float64Array)
    codeSumSqs = fixedView(bound.codeSumSqs, Float64Array)
    codeMagnitudes = fixedView(bound.codeMagnitudes, Float64Array)
    codePresent = fixedView(bound.codePresent, Uint8Array)
  }

  function reach(ordinal: number): boolean {
    if (bound !== store.handles || ordinal >= codePresent.length) {
      if (ordinal >= store.handles.codePresent.byteLength) return false
      rebind()
    }
    return true
  }

  function constants(): Sq8Constants {
    const calibration = store.handles.calibration
    const alpha = calibration[CALIBRATION_ALPHA]
    const offset = calibration[CALIBRATION_OFFSET]
    if (alpha !== cachedAlpha || offset !== cachedOffset) {
      cachedConstants = deriveSq8Constants(alpha, offset, dimension)
      cachedAlpha = alpha
      cachedOffset = offset
    }
    return cachedConstants
  }

  function isCalibrated(): boolean {
    return Atomics.load(store.handles.header, STORE_CALIBRATED) === 1
  }

  function holds(ordinal: number): boolean {
    return ordinal >= 0 && reach(ordinal) && codePresent[ordinal] === 1
  }

  function codeByteOffset(ordinal: number): number {
    return slotByteOffset(store.handles.layout, store.localOrdinal(ordinal)) + store.handles.layout.codeOffsetInSlot
  }

  function markPresent(ordinal: number): void {
    if (Atomics.exchange(codePresent, ordinal, 1) === 0) Atomics.add(store.handles.header, STORE_CODE_COUNT, 1)
  }

  return {
    get size() {
      return Atomics.load(store.handles.header, STORE_CODE_COUNT)
    },

    get calibration(): ScalarQuantizerCalibration | null {
      if (!isCalibrated()) return null
      const calibration = store.handles.calibration
      return { alpha: calibration[CALIBRATION_ALPHA], offset: calibration[CALIBRATION_OFFSET] }
    },

    isCalibrated,
    constants,
    holdsOrdinal: holds,

    codesAt(ordinal) {
      return store.codesAt(ordinal)
    },

    codeSumAt(ordinal) {
      reach(ordinal)
      return codeSums[ordinal]
    },

    codeSumSqAt(ordinal) {
      reach(ordinal)
      return codeSumSqs[ordinal]
    },

    writeCodes(ordinal, vector) {
      if (!reach(ordinal)) return
      const derived = constants()
      const { sum, sumSq } = quantizeVectorInto(store.codesAt(ordinal), vector, dimension, derived)
      codeSums[ordinal] = sum
      codeSumSqs[ordinal] = sumSq
      codeMagnitudes[ordinal] = quantizedMagnitude(derived, sumSq, sum)
      markPresent(ordinal)
    },

    restoreCodes(ordinal, quantized, sum, sumSq) {
      if (!reach(ordinal)) return
      store.codesAt(ordinal).set(quantized.subarray(0, dimension))
      codeSums[ordinal] = sum
      codeSumSqs[ordinal] = sumSq
      codeMagnitudes[ordinal] = quantizedMagnitude(constants(), sumSq, sum)
      markPresent(ordinal)
    },

    clearCodes(ordinal) {
      if (ordinal < 0 || !reach(ordinal)) return
      if (Atomics.exchange(codePresent, ordinal, 0) === 1) Atomics.sub(store.handles.header, STORE_CODE_COUNT, 1)
    },

    writeCalibration(alpha, offset) {
      const calibration = store.handles.calibration
      calibration[CALIBRATION_ALPHA] = alpha
      calibration[CALIBRATION_OFFSET] = offset
      Atomics.store(store.handles.header, STORE_CALIBRATED, 1)
    },

    resetCalibration() {
      const calibration = store.handles.calibration
      Atomics.store(store.handles.header, STORE_CALIBRATED, 0)
      calibration[CALIBRATION_ALPHA] = 0
      calibration[CALIBRATION_OFFSET] = 0
    },

    resetCodes() {
      rebind()
      codePresent.fill(0)
      Atomics.store(store.handles.header, STORE_CODE_COUNT, 0)
    },

    prepareQuery(query) {
      if (!isCalibrated()) return null
      const derived = constants()
      const quantized = new Uint8Array(dimension)
      const { sum, sumSq } = quantizeVectorInto(quantized, query, dimension, derived)
      return { quantized, sum, sumSq, magnitude: quantizedMagnitude(derived, sumSq, sum) }
    },

    distanceFromPreparedByOrdinal(prepared: QuantizedQuery, ordinal: number, metric: VectorMetric) {
      if (!holds(ordinal)) return Number.POSITIVE_INFINITY
      return scalarQuantizedDistance(
        store.codesAt(ordinal),
        0,
        dimension,
        constants(),
        prepared.quantized,
        prepared.sum,
        prepared.magnitude,
        codeSums[ordinal],
        codeMagnitudes[ordinal],
        metric,
      )
    },

    prepareQueryArena(query): ArenaQuery | null {
      if (!isCalibrated() || !store.simdAvailable) return null
      const derived = constants()
      if (queryCodes === null || queryCodes.length !== dimension) queryCodes = new Uint8Array(dimension)
      const { sum, sumSq } = quantizeVectorInto(queryCodes, query, dimension, derived)
      for (let index = 0; index < store.handles.blocks.length; index++) {
        store.blockOf(index * store.handles.layout.capacity).codeQueryStaged = false
      }
      return { sum, sumSq, magnitude: quantizedMagnitude(derived, sumSq, sum) }
    },

    distanceFromArena(prepared: ArenaQuery, ordinal: number, metric: VectorMetric) {
      if (!holds(ordinal) || queryCodes === null) return Number.POSITIVE_INFINITY
      const block = store.blockOf(ordinal)
      if (block.simd === null || !block.hasScratch) {
        return scalarQuantizedDistance(
          store.codesAt(ordinal),
          0,
          dimension,
          constants(),
          queryCodes,
          prepared.sum,
          prepared.magnitude,
          codeSums[ordinal],
          codeMagnitudes[ordinal],
          metric,
        )
      }
      if (!block.codeQueryStaged) {
        block.bytes(block.codeScratchByteOffset + dimension).set(queryCodes, block.codeScratchByteOffset)
        block.codeQueryStaged = true
      }
      return arenaQuantizedDistance(
        block.simd,
        block.codeScratchByteOffset,
        codeByteOffset(ordinal),
        dimension,
        constants(),
        prepared.sum,
        prepared.magnitude,
        codeSums[ordinal],
        codeMagnitudes[ordinal],
        metric,
      )
    },
  }
}
