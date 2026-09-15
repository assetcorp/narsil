import type { VectorMetric } from '../brute-force'
import { fixedView } from '../shared-buffers/growable'
import { NOTHING_STAGED, type OpenVectorBlock, QUERY_STAGED, slotByteOffset } from '../vector-store/blocks'
import type { VectorCodeBlockLayout } from '../vector-store/code-blocks'
import { STORE_CALIBRATED, STORE_CALIBRATION_GENERATION, STORE_CODE_COUNT } from '../vector-store/handles'
import type { SharedVectorStoreView } from '../vector-store/view'
import { osqByteLevelProducts, osqDistance, osqEstimate, osqPackedLevelProducts } from './estimate'
import { createOsqScratch, type OsqBits, osqQuantize } from './quantize'
import { type OsqTrailer, osqCodeBytes, packLevels, readTrailer, writeRecord } from './record'
import type { OsqQuery, QuantizerSearchReader } from './types'

export interface SharedQuantizerView extends QuantizerSearchReader {
  readonly bits: OsqBits
  readonly metric: VectorMetric
  /** The centroid the quantizer takes every record against, or null before calibration. */
  readonly centroid: Float32Array | null
  holdsOrdinal(ordinal: number): boolean
  /** Quantizes a vector and writes its record at the ordinal. */
  writeCodes(ordinal: number, vector: Float32Array): void
  /** Copies a record written elsewhere into the ordinal's slot. */
  restoreRecord(ordinal: number, record: Uint8Array): void
  /** Reads the record at an ordinal in place, which the caller copies before the slot changes. */
  recordAt(ordinal: number): Uint8Array
  clearCodes(ordinal: number): void
  writeCentroid(centroid: Float32Array): void
  resetCalibration(): void
  resetCodes(): void
  /** Estimates the distance between two ordinals from their records, for a graph built from codes. */
  distanceBetweenOrdinals(ordA: number, ordB: number): number
}

export function openSharedQuantizer(
  store: SharedVectorStoreView,
  layout: VectorCodeBlockLayout,
  metric: VectorMetric,
): SharedQuantizerView {
  const { dimension, bits, queryBits, codeBytes, planeBytes, capacity } = layout
  const scratch = createOsqScratch(dimension)
  const documentTrailer: OsqTrailer = { lower: 0, upper: 0, correction: 0, sum: 0 }
  const otherTrailer: OsqTrailer = { lower: 0, upper: 0, correction: 0, sum: 0 }
  let codePresent = fixedView(store.handles.codePresent, Uint8Array)
  let centroidDot = 0
  let centroidGeneration = -1
  let currentQuery: OsqQuery | null = null

  function reach(ordinal: number): boolean {
    if (ordinal < codePresent.length) return true
    if (ordinal >= store.handles.codePresent.byteLength) return false
    codePresent = fixedView(store.handles.codePresent, Uint8Array)
    return ordinal < codePresent.length
  }

  function isCalibrated(): boolean {
    return Atomics.load(store.handles.header, STORE_CALIBRATED) === 1
  }

  function centroidDotNow(): number {
    const generation = Atomics.load(store.handles.header, STORE_CALIBRATION_GENERATION)
    if (generation !== centroidGeneration) {
      const centroid = store.handles.centroid
      let total = 0
      for (let i = 0; i < dimension; i++) total += centroid[i] * centroid[i]
      centroidDot = total
      centroidGeneration = generation
    }
    return centroidDot
  }

  function holds(ordinal: number): boolean {
    return ordinal >= 0 && reach(ordinal) && codePresent[ordinal] === 1
  }

  function recordOffset(ordinal: number): number {
    return slotByteOffset(layout, ordinal % capacity)
  }

  function markPresent(ordinal: number): void {
    if (Atomics.exchange(codePresent, ordinal, 1) === 0) Atomics.add(store.handles.header, STORE_CODE_COUNT, 1)
  }

  function stageQuery(block: OpenVectorBlock, query: OsqQuery): boolean {
    if (block.simd === null || !block.hasScratch) return false
    if (block.stagedOrdinal !== QUERY_STAGED) {
      block.bytes(block.scratchByteOffset + query.packed.length).set(query.packed, block.scratchByteOffset)
      block.stagedOrdinal = QUERY_STAGED
    }
    return true
  }

  function productsInBlock(block: OpenVectorBlock, documentOffset: number, queryOffset: number): number {
    if (block.simd !== null) {
      if (bits === 8) return block.simd.dot_u8(documentOffset, queryOffset, dimension)
      if (bits === 4 && queryBits === 4) return block.simd.osq_dot_planes_4x4(documentOffset, queryOffset, planeBytes)
      return block.simd.osq_dot_planes(documentOffset, queryOffset, planeBytes, bits, queryBits)
    }
    const bytes = block.bytes(Math.max(documentOffset, queryOffset) + codeBytes)
    return bits === 8
      ? osqByteLevelProducts(bytes, documentOffset, bytes, queryOffset, dimension)
      : osqPackedLevelProducts(bytes, documentOffset, bits, bytes, queryOffset, queryBits, planeBytes)
  }

  function productsAgainstQuery(block: OpenVectorBlock, documentOffset: number, query: OsqQuery): number {
    if (stageQuery(block, query)) return productsInBlock(block, documentOffset, block.scratchByteOffset)
    const bytes = block.bytes(documentOffset + codeBytes)
    return bits === 8
      ? osqByteLevelProducts(bytes, documentOffset, query.packed, 0, dimension)
      : osqPackedLevelProducts(bytes, documentOffset, bits, query.packed, 0, queryBits, planeBytes)
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
    const packed = new Uint8Array(osqCodeBytes(dimension, queryBits))
    packLevels(code.levels, queryBits, packed, 0)
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

    writeCodes(ordinal, vector) {
      if (!reach(ordinal) || !isCalibrated()) return
      const code = osqQuantize(vector, store.handles.centroid, bits, metric, scratch)
      const block = store.codeBlockOf(ordinal)
      const offset = recordOffset(ordinal)
      writeRecord(block.bytes(offset + layout.slotStride), offset, code, bits, block.data(offset + layout.slotStride))
      markPresent(ordinal)
    },

    restoreRecord(ordinal, record) {
      if (!reach(ordinal) || record.length !== layout.slotStride) return
      const block = store.codeBlockOf(ordinal)
      const offset = recordOffset(ordinal)
      block.bytes(offset + layout.slotStride).set(record, offset)
      markPresent(ordinal)
    },

    recordAt(ordinal) {
      const block = store.codeBlockOf(ordinal)
      const offset = recordOffset(ordinal)
      return block.bytes(offset + layout.slotStride).subarray(offset, offset + layout.slotStride)
    },

    clearCodes(ordinal) {
      if (ordinal < 0 || !reach(ordinal)) return
      if (Atomics.exchange(codePresent, ordinal, 0) === 1) Atomics.sub(store.handles.header, STORE_CODE_COUNT, 1)
    },

    writeCentroid(centroid) {
      store.handles.centroid.set(centroid)
      Atomics.add(store.handles.header, STORE_CALIBRATION_GENERATION, 1)
      Atomics.store(store.handles.header, STORE_CALIBRATED, 1)
    },

    resetCalibration() {
      Atomics.store(store.handles.header, STORE_CALIBRATED, 0)
      store.handles.centroid.fill(0)
      Atomics.add(store.handles.header, STORE_CALIBRATION_GENERATION, 1)
    },

    resetCodes() {
      codePresent = fixedView(store.handles.codePresent, Uint8Array)
      codePresent.fill(0)
      Atomics.store(store.handles.header, STORE_CODE_COUNT, 0)
    },

    prepareQuery,

    distanceFromPreparedByOrdinal(prepared, ordinal) {
      if (!holds(ordinal)) return Number.POSITIVE_INFINITY
      return estimateDistance(ordinal, prepared)
    },

    distanceBetweenOrdinals(ordA, ordB) {
      if (!holds(ordA) || !holds(ordB)) return Number.POSITIVE_INFINITY
      const blockA = store.codeBlockOf(ordA)
      const blockB = store.codeBlockOf(ordB)
      const offsetA = recordOffset(ordA)
      const offsetB = recordOffset(ordB)
      let products: number
      if (blockA === blockB && blockA.simd !== null) {
        products =
          bits === 8
            ? blockA.simd.dot_u8(offsetA, offsetB, dimension)
            : bits === 4
              ? blockA.simd.osq_dot_planes_4x4(offsetA, offsetB, planeBytes)
              : blockA.simd.osq_dot_planes(offsetA, offsetB, planeBytes, bits, bits)
      } else {
        const bytesA = blockA.bytes(offsetA + codeBytes)
        const bytesB = blockB.bytes(offsetB + codeBytes)
        products =
          bits === 8
            ? osqByteLevelProducts(bytesA, offsetA, bytesB, offsetB, dimension)
            : osqPackedLevelProducts(bytesA, offsetA, bits, bytesB, offsetB, bits, planeBytes)
      }
      readTrailer(blockA.data(offsetA + layout.slotStride), offsetA, codeBytes, documentTrailer)
      readTrailer(blockB.data(offsetB + layout.slotStride), offsetB, codeBytes, otherTrailer)
      return osqDistance(
        osqEstimate(products, documentTrailer, bits, otherTrailer, bits, dimension, centroidDotNow(), metric),
        metric,
      )
    },
  }
}
