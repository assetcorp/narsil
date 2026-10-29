import type { VectorMetric } from '../brute-force'
import { noteFallback } from '../native/backend'
import { nativeMeasure, nativeQuantise } from '../native/store'
import { fixedView } from '../shared-buffers/growable'
import { NOTHING_STAGED, type OpenVectorBlock, QUERY_STAGED, slotByteOffset } from '../vector-store/blocks'
import type { VectorCodeBlockLayout } from '../vector-store/code-blocks'
import { STORE_CALIBRATED, STORE_CALIBRATION_GENERATION, STORE_CODE_COUNT } from '../vector-store/handles'
import type { SharedVectorStoreView } from '../vector-store/view'
import { osqDistance, osqEstimate, osqNibblesByByteLevels, osqPlacementQueryBits } from './estimate'
import { scalarPairProducts, scalarQueryProducts, simdPairProducts, simdQueryProducts } from './products'
import {
  addToCentroidSums,
  type CentroidSums,
  centroidOfCentroidSums,
  createCentroidSums,
  createOsqScratch,
  type OsqBits,
  osqQuantize,
} from './quantize'
import { type CodeRecoding, createCodeRecoding } from './recoding'
import { type OsqTrailer, readTrailer, stageQueryLevels, writeRecord } from './record'
import type { OsqQuery, QuantizerSearchReader } from './types'

export interface SharedQuantizerView extends QuantizerSearchReader {
  readonly bits: OsqBits
  readonly metric: VectorMetric
  /** The centroid the quantizer takes every record against, or null before calibration. */
  readonly centroid: Float32Array | null
  holdsOrdinal(ordinal: number): boolean
  /** Quantizes the stored vector of an ordinal and writes its record. */
  writeCodes(ordinal: number): void
  /** Quantizes the stored vector of every given ordinal and writes its record. */
  writeCodesOf(ordinals: Int32Array): void
  /** Adds the stored vectors of the given ordinals to the running sums, reading each vector once. */
  measureInto(ordinals: Int32Array, sums: CentroidSums): void
  /** Takes the centroid from the stored vectors of the given ordinals, and reports false where the store holds none of them. */
  calibrateFrom(ordinals: Int32Array): boolean
  /** Copies a record written elsewhere into the ordinal's slot. */
  restoreRecord(ordinal: number, record: Uint8Array): void
  /** Reads the record at an ordinal in place, which the caller copies before the slot changes. */
  recordAt(ordinal: number): Uint8Array
  clearCodes(ordinal: number): void
  writeCentroid(centroid: Float32Array): void
  resetCalibration(): void
  resetCodes(): void
  beginRecoding(centroid: Float32Array): void
  recode(ordinal: number): void
  finishRecoding(): boolean
  abandonRecoding(): void
  /** Estimates the distance between two ordinals from their records, for a graph built from codes. */
  pairDistance(): (ordA: number, ordB: number) => number
  /** Estimates the distance from a vector being placed to each ordinal's record, or returns null before calibration. */
  placementDistance(vector: Float32Array): ((ordinal: number) => number) | null
}

export function openSharedQuantizer(
  store: SharedVectorStoreView,
  layout: VectorCodeBlockLayout,
  metric: VectorMetric,
): SharedQuantizerView {
  const { dimension, bits, queryBits, codeBytes, capacity } = layout
  const scratch = createOsqScratch(dimension)
  const placementQueryBits = osqPlacementQueryBits(bits)
  const documentTrailer: OsqTrailer = { lower: 0, upper: 0, correction: 0, sum: 0 }
  const otherTrailer: OsqTrailer = { lower: 0, upper: 0, correction: 0, sum: 0 }
  let codePresent = fixedView(store.handles.codePresent, Uint8Array)
  let centroidDot = 0
  let centroidGeneration = -1
  let currentQuery: OsqQuery | null = null
  let recoding: CodeRecoding | null = null
  const singleOrdinal = new Int32Array(1)

  function reach(ordinal: number): boolean {
    if (ordinal < codePresent.length) return true
    if (ordinal >= store.handles.codePresent.byteLength) return false
    codePresent = fixedView(store.handles.codePresent, Uint8Array)
    return ordinal < codePresent.length
  }

  function isCalibrated(): boolean {
    return Atomics.load(store.handles.header, STORE_CALIBRATED) === 1
  }

  function recomputeCentroidDot(generation: number): void {
    const centroid = store.handles.centroid
    let total = 0
    for (let i = 0; i < dimension; i++) total += centroid[i] * centroid[i]
    centroidDot = total
    centroidGeneration = generation
  }

  function centroidDotNow(): number {
    const generation = Atomics.load(store.handles.header, STORE_CALIBRATION_GENERATION)
    if (generation !== centroidGeneration) recomputeCentroidDot(generation)
    return centroidDot
  }

  function holds(ordinal: number): boolean {
    return ordinal >= 0 && reach(ordinal) && codePresent[ordinal] === 1
  }

  function recordOffset(ordinal: number): number {
    return slotByteOffset(layout, ordinal % capacity)
  }

  function markPresent(ordinal: number): void {
    if (Atomics.load(codePresent, ordinal) !== 0) return
    Atomics.add(store.handles.header, STORE_CODE_COUNT, 1)
    Atomics.store(codePresent, ordinal, 1)
  }

  function writeCentroid(centroid: Float32Array): void {
    store.handles.centroid.set(centroid)
    Atomics.add(store.handles.header, STORE_CALIBRATION_GENERATION, 1)
    Atomics.store(store.handles.header, STORE_CALIBRATED, 1)
  }

  function measureInto(ordinals: Int32Array, sums: CentroidSums): void {
    if (nativeMeasure(store.handles, metric, ordinals, sums.totals)) return
    noteFallback('measure')
    for (const vector of storedVectors(ordinals)) addToCentroidSums(sums, vector)
  }

  function* storedVectors(ordinals: Int32Array): Iterable<Float32Array> {
    for (const ordinal of ordinals) {
      if (store.holdsOrdinal(ordinal)) yield store.vectorAt(ordinal)
    }
  }

  function writeRecordOf(ordinal: number): void {
    if (!reach(ordinal) || !store.holdsOrdinal(ordinal)) return
    const code = osqQuantize(store.vectorAt(ordinal), store.handles.centroid, bits, metric, scratch)
    const block = store.codeBlockOf(ordinal)
    const offset = recordOffset(ordinal)
    writeRecord(block.bytes(offset + layout.slotStride), offset, code, bits, block.data(offset + layout.slotStride))
    markPresent(ordinal)
    recoding?.recode(ordinal)
  }

  function writeCodesOf(ordinals: Int32Array): void {
    if (!isCalibrated() || ordinals.length === 0) return
    if (nativeQuantise(store.handles, metric, ordinals)) {
      if (recoding !== null) for (const ordinal of ordinals) recoding.recode(ordinal)
      return
    }
    noteFallback('quantise')
    for (const ordinal of ordinals) writeRecordOf(ordinal)
  }

  function clearCodes(ordinal: number): void {
    if (ordinal < 0 || !reach(ordinal)) return
    if (Atomics.exchange(codePresent, ordinal, 0) === 1) Atomics.sub(store.handles.header, STORE_CODE_COUNT, 1)
  }

  function stageQuery(block: OpenVectorBlock, query: OsqQuery): boolean {
    if (block.simd === null || !block.hasScratch) return false
    if (block.stagedOrdinal !== QUERY_STAGED) {
      block.bytes(block.scratchByteOffset + query.packed.length).set(query.packed, block.scratchByteOffset)
      block.stagedOrdinal = QUERY_STAGED
    }
    return true
  }

  function productsAgainstQuery(block: OpenVectorBlock, documentOffset: number, query: OsqQuery): number {
    if (block.simd !== null && stageQuery(block, query)) {
      return simdQueryProducts(block.simd, layout, documentOffset, block.scratchByteOffset)
    }
    return scalarQueryProducts(layout, block.bytes(documentOffset + codeBytes), documentOffset, query.packed)
  }

  function distanceFrom(products: number, query: OsqTrailer, levelBits: OsqBits): number {
    const estimate = osqEstimate(products, documentTrailer, bits, query, levelBits, dimension, centroidDotNow(), metric)
    return osqDistance(estimate, metric)
  }

  function estimateDistance(ordinal: number, query: OsqQuery): number {
    const block = store.codeBlockOf(ordinal)
    const offset = recordOffset(ordinal)
    const products = productsAgainstQuery(block, offset, query)
    readTrailer(block.data(offset + layout.slotStride), offset, codeBytes, documentTrailer)
    return distanceFrom(products, query, queryBits)
  }

  function prepareQuery(query: Float32Array): OsqQuery | null {
    if (!isCalibrated() || query.length !== dimension) return null
    const code = osqQuantize(query, store.handles.centroid, queryBits, metric, scratch)
    const packed = new Uint8Array(layout.queryBytes)
    stageQueryLevels(code.levels, bits, packed)
    for (const block of store.openCodeBlocks()) block.stagedOrdinal = NOTHING_STAGED
    currentQuery = {
      packed,
      lower: code.lower,
      upper: code.upper,
      correction: code.correction,
      sum: code.sum,
    }
    return currentQuery
  }

  function preparedDistance(prepared: OsqQuery): (ordinal: number) => number {
    const generic = (ordinal: number): number =>
      holds(ordinal) ? estimateDistance(ordinal, prepared) : Number.POSITIVE_INFINITY
    if (store.handles.codeBlocks.length === 0) return generic
    const block = store.codeBlockOf(0)
    const simd = block.simd
    if (simd === null || !block.hasScratch) return generic
    const presentView = codePresent
    const limit = Math.min(presentView.length, capacity)
    const { slotsOffset, slotStride } = layout
    const data = block.data(slotsOffset + slotStride)
    const dataLength = data.byteLength
    const queryOffset = block.scratchByteOffset
    return ordinal => {
      if (ordinal < 0 || ordinal >= limit || block.stagedOrdinal !== QUERY_STAGED) return generic(ordinal)
      if (presentView[ordinal] !== 1) return Number.POSITIVE_INFINITY
      const offset = slotsOffset + ordinal * slotStride
      if (offset + slotStride > dataLength) return generic(ordinal)
      const products = simdQueryProducts(simd, layout, offset, queryOffset)
      readTrailer(data, offset, codeBytes, documentTrailer)
      return distanceFrom(products, prepared, queryBits)
    }
  }

  function placementDistance(vector: Float32Array): ((ordinal: number) => number) | null {
    if (placementQueryBits === queryBits) {
      const prepared = prepareQuery(vector)
      return prepared === null ? null : preparedDistance(prepared)
    }
    if (!isCalibrated() || vector.length !== dimension) return null
    const code = osqQuantize(vector, store.handles.centroid, placementQueryBits, metric, scratch)
    const levels = new Uint8Array(2 * codeBytes)
    levels.set(code.levels)
    return ordinal => {
      if (!holds(ordinal)) return Number.POSITIVE_INFINITY
      const block = store.codeBlockOf(ordinal)
      const offset = recordOffset(ordinal)
      const products = osqNibblesByByteLevels(block.bytes(offset + codeBytes), offset, levels, codeBytes)
      readTrailer(block.data(offset + layout.slotStride), offset, codeBytes, documentTrailer)
      return distanceFrom(products, code, placementQueryBits)
    }
  }

  function distanceBetween(ordA: number, ordB: number): number {
    if (!holds(ordA) || !holds(ordB)) return Number.POSITIVE_INFINITY
    const blockA = store.codeBlockOf(ordA)
    const blockB = store.codeBlockOf(ordB)
    const offsetA = recordOffset(ordA)
    const offsetB = recordOffset(ordB)
    const products =
      blockA === blockB && blockA.simd !== null
        ? simdPairProducts(blockA.simd, layout, offsetA, offsetB)
        : scalarPairProducts(
            layout,
            blockA.bytes(offsetA + codeBytes),
            offsetA,
            blockB.bytes(offsetB + codeBytes),
            offsetB,
          )
    readTrailer(blockA.data(offsetA + layout.slotStride), offsetA, codeBytes, documentTrailer)
    readTrailer(blockB.data(offsetB + layout.slotStride), offsetB, codeBytes, otherTrailer)
    return distanceFrom(products, otherTrailer, bits)
  }

  function pairDistance(): (ordA: number, ordB: number) => number {
    if (store.handles.codeBlocks.length === 0) return distanceBetween
    const block = store.codeBlockOf(0)
    const simd = block.simd
    if (simd === null) return distanceBetween
    const presentView = codePresent
    const limit = Math.min(presentView.length, capacity)
    const { slotsOffset, slotStride } = layout
    const data = block.data(slotsOffset + slotStride)
    const dataLength = data.byteLength
    return (ordA, ordB) => {
      if (ordA < 0 || ordB < 0 || ordA >= limit || ordB >= limit) return distanceBetween(ordA, ordB)
      if (presentView[ordA] !== 1 || presentView[ordB] !== 1) return Number.POSITIVE_INFINITY
      const offsetA = slotsOffset + ordA * slotStride
      const offsetB = slotsOffset + ordB * slotStride
      if (Math.max(offsetA, offsetB) + slotStride > dataLength) return distanceBetween(ordA, ordB)
      const products = simdPairProducts(simd, layout, offsetA, offsetB)
      readTrailer(data, offsetA, codeBytes, documentTrailer)
      readTrailer(data, offsetB, codeBytes, otherTrailer)
      return distanceFrom(products, otherTrailer, bits)
    }
  }

  return {
    bits,
    metric,

    get size() {
      return Atomics.load(store.handles.header, STORE_CODE_COUNT)
    },

    get centroid(): Float32Array | null {
      return isCalibrated() ? store.handles.centroid : null
    },

    isCalibrated,
    holdsOrdinal: holds,

    writeCodes(ordinal) {
      singleOrdinal[0] = ordinal
      writeCodesOf(singleOrdinal)
    },

    writeCodesOf,

    measureInto,

    calibrateFrom(ordinals) {
      const sums = createCentroidSums(dimension, metric)
      measureInto(ordinals, sums)
      const centroid = centroidOfCentroidSums(sums)
      if (centroid === null) return false
      writeCentroid(centroid)
      return true
    },

    restoreRecord(ordinal, record) {
      if (!reach(ordinal) || record.length !== layout.slotStride) return
      const block = store.codeBlockOf(ordinal)
      const offset = recordOffset(ordinal)
      block.bytes(offset + layout.slotStride).set(record, offset)
      markPresent(ordinal)
      recoding?.recode(ordinal)
    },

    recordAt(ordinal) {
      const block = store.codeBlockOf(ordinal)
      const offset = recordOffset(ordinal)
      return block.bytes(offset + layout.slotStride).subarray(offset, offset + layout.slotStride)
    },

    clearCodes,

    writeCentroid,

    resetCalibration() {
      recoding = null
      Atomics.store(store.handles.header, STORE_CALIBRATED, 0)
      store.handles.centroid.fill(0)
      Atomics.add(store.handles.header, STORE_CALIBRATION_GENERATION, 1)
    },

    resetCodes() {
      recoding = null
      codePresent = fixedView(store.handles.codePresent, Uint8Array)
      codePresent.fill(0)
      Atomics.store(store.handles.header, STORE_CODE_COUNT, 0)
    },

    beginRecoding(centroid) {
      recoding = createCodeRecoding({ store, layout, metric, holds, clearCodes }, Float32Array.from(centroid))
    },

    recode(ordinal) {
      recoding?.recode(ordinal)
    },

    finishRecoding() {
      if (recoding === null) return false
      const finished = recoding
      recoding = null
      finished.copyIntoStore(store.slots)
      writeCentroid(finished.centroid)
      return true
    },

    abandonRecoding() {
      recoding = null
    },

    prepareQuery,

    distanceFromPreparedByOrdinal(prepared, ordinal) {
      if (!holds(ordinal)) return Number.POSITIVE_INFINITY
      return estimateDistance(ordinal, prepared)
    },

    preparedDistance,
    pairDistance,
    placementDistance,
  }
}
