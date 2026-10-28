import type { VectorMetric } from '../brute-force'
import { noteFallback } from '../native/backend'
import { nativeCalibrate, nativeQuantise } from '../native/store'
import { fixedView } from '../shared-buffers/growable'
import type { ArenaSimd } from '../simd'
import { NOTHING_STAGED, type OpenVectorBlock, QUERY_STAGED, slotByteOffset } from '../vector-store/blocks'
import type { VectorCodeBlockLayout } from '../vector-store/code-blocks'
import { STORE_CALIBRATED, STORE_CALIBRATION_GENERATION, STORE_CODE_COUNT } from '../vector-store/handles'
import type { SharedVectorStoreView } from '../vector-store/view'
import { osqByteLevelProducts, osqDistance, osqEstimate, osqNibbleProducts, osqStagedQueryProducts } from './estimate'
import { createOsqScratch, type OsqBits, osqCentroid, osqQuantize } from './quantize'
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
  /** Starts taking every record again against a new centroid in memory of its own, while searches go on reading the current records. */
  beginRecoding(centroid: Float32Array): void
  /** Takes the record of one ordinal against the new centroid, and does nothing while no recoding runs. */
  recode(ordinal: number): void
  /** Puts the new records and centroid in place of the current ones, which the caller does while it holds the graph alone, and reports false where no recoding ran. */
  finishRecoding(): boolean
  abandonRecoding(): void
}

export function openSharedQuantizer(
  store: SharedVectorStoreView,
  layout: VectorCodeBlockLayout,
  metric: VectorMetric,
): SharedQuantizerView {
  const { dimension, bits, queryBits, codeBytes, capacity } = layout
  const scratch = createOsqScratch(dimension)
  const documentTrailer: OsqTrailer = { lower: 0, upper: 0, correction: 0, sum: 0 }
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

  function simdQueryProducts(simd: ArenaSimd, documentOffset: number, queryOffset: number): number {
    if (bits === 8) return simd.dot_u8(documentOffset, queryOffset, dimension)
    if (bits === 4) return simd.osq_dot_nibbles_4x4(documentOffset, queryOffset, codeBytes)
    return simd.osq_dot_bits(documentOffset, queryOffset, codeBytes, bits)
  }

  function productsAgainstQuery(block: OpenVectorBlock, documentOffset: number, query: OsqQuery): number {
    if (block.simd !== null && stageQuery(block, query)) {
      return simdQueryProducts(block.simd, documentOffset, block.scratchByteOffset)
    }
    const bytes = block.bytes(documentOffset + codeBytes)
    if (bits === 8) return osqByteLevelProducts(bytes, documentOffset, query.packed, 0, dimension)
    if (bits === 4) return osqNibbleProducts(bytes, documentOffset, query.packed, 0, codeBytes)
    return osqStagedQueryProducts(bytes, documentOffset, bits, query.packed, 0, codeBytes)
  }

  function estimateDistance(ordinal: number, query: OsqQuery): number {
    const block = store.codeBlockOf(ordinal)
    const offset = recordOffset(ordinal)
    const products = productsAgainstQuery(block, offset, query)
    readTrailer(block.data(offset + layout.slotStride), offset, codeBytes, documentTrailer)
    return osqDistance(
      osqEstimate(products, documentTrailer, bits, query, queryBits, dimension, centroidDotNow(), metric),
      metric,
    )
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

    calibrateFrom(ordinals) {
      if (nativeCalibrate(store.handles, metric, ordinals)) return isCalibrated()
      noteFallback('calibrate')
      const centroid = osqCentroid(storedVectors(ordinals), dimension, metric)
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

    preparedDistance(prepared) {
      const generic = (ordinal: number): number =>
        holds(ordinal) ? estimateDistance(ordinal, prepared) : Number.POSITIVE_INFINITY
      if (store.handles.codeBlocks.length === 0) return generic
      const block = store.codeBlockOf(0)
      const simd = block.simd
      if (simd === null || !block.hasScratch) return generic
      const presentView = codePresent
      const limit = Math.min(presentView.length, capacity)
      const data = block.data(0)
      const dataLength = data.byteLength
      const queryOffset = block.scratchByteOffset
      const { slotsOffset, slotStride } = layout
      return ordinal => {
        if (ordinal < 0 || ordinal >= limit || block.stagedOrdinal !== QUERY_STAGED) return generic(ordinal)
        if (presentView[ordinal] !== 1) return Number.POSITIVE_INFINITY
        const offset = slotsOffset + ordinal * slotStride
        if (offset + slotStride > dataLength) return generic(ordinal)
        const products = simdQueryProducts(simd, offset, queryOffset)
        readTrailer(data, offset, codeBytes, documentTrailer)
        const estimate = osqEstimate(
          products,
          documentTrailer,
          bits,
          prepared,
          queryBits,
          dimension,
          centroidDotNow(),
          metric,
        )
        return osqDistance(estimate, metric)
      }
    },
  }
}
