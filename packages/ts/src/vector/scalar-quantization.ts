import type { VectorMetric } from './brute-force'
import { computeCalibrationBounds } from './scalar-quantization-calibration'
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
  OrdinalSource,
  QuantizedQuery,
  ScalarQuantizer,
  ScalarQuantizerCalibration,
  SerializedSQ8,
} from './scalar-quantization-types'
import { type ArenaSimd, createArenaSimd } from './simd'

const INITIAL_CAPACITY = 16
const PAGE_BYTES = 65536

export function createScalarQuantizer(dimensions: number, ordinalSource?: OrdinalSource): ScalarQuantizer {
  const docToOrd = new Map<string, number>()
  let simd: ArenaSimd | null = createArenaSimd()
  const arenaByteOffset = simd ? Math.max(16, Math.ceil(dimensions / 16) * 16) : 0

  let capacity = 0
  let quantizedArena = simd ? new Uint8Array(simd.memory.buffer, arenaByteOffset) : new Uint8Array(0)
  let scratch = simd ? new Uint8Array(simd.memory.buffer, 0, arenaByteOffset) : new Uint8Array(0)
  let sums = new Float64Array(0)
  let sumSqs = new Float64Array(0)
  let mags = new Float64Array(0)
  let present = new Uint8Array(0)
  let selfNextOrd = 0
  let liveCount = 0

  let constants: Sq8Constants = deriveSq8Constants(0, 0, dimensions)
  let calibrated = false

  function ensureCapacity(needed: number): void {
    if (needed <= capacity) return
    let newCap = capacity === 0 ? INITIAL_CAPACITY : capacity
    while (newCap < needed) newCap *= 2

    const nextSums = new Float64Array(newCap)
    nextSums.set(sums)
    sums = nextSums
    const nextSumSqs = new Float64Array(newCap)
    nextSumSqs.set(sumSqs)
    sumSqs = nextSumSqs
    const nextMags = new Float64Array(newCap)
    nextMags.set(mags)
    mags = nextMags
    const nextPresent = new Uint8Array(newCap)
    nextPresent.set(present)
    present = nextPresent

    if (simd) {
      const requiredBytes = arenaByteOffset + newCap * dimensions
      const have = simd.memory.buffer.byteLength
      if (requiredBytes > have) {
        try {
          simd.memory.grow(Math.ceil((requiredBytes - have) / PAGE_BYTES))
        } catch {
          const migrated = new Uint8Array(newCap * dimensions)
          migrated.set(quantizedArena.subarray(0, capacity * dimensions))
          quantizedArena = migrated
          simd = null
          capacity = newCap
          return
        }
      }
      quantizedArena = new Uint8Array(simd.memory.buffer, arenaByteOffset)
      scratch = new Uint8Array(simd.memory.buffer, 0, arenaByteOffset)
    } else {
      const nextArena = new Uint8Array(newCap * dimensions)
      nextArena.set(quantizedArena)
      quantizedArena = nextArena
    }

    capacity = newCap
  }

  function resolveOrdinal(docId: string): number {
    const fromSource = ordinalSource?.getOrdinal(docId)
    if (fromSource !== undefined) return fromSource
    const known = docToOrd.get(docId)
    if (known !== undefined) return known
    return selfNextOrd++
  }

  function quantizeInto(ord: number, vector: Float32Array): void {
    const base = ord * dimensions
    const { sum, sumSq } = quantizeVectorInto(
      quantizedArena.subarray(base, base + dimensions),
      vector,
      dimensions,
      constants,
    )
    sums[ord] = sum
    sumSqs[ord] = sumSq
    mags[ord] = quantizedMagnitude(constants, sumSq, sum)
  }

  function storeEntry(docId: string, ord: number): void {
    if (present[ord] === 0) {
      present[ord] = 1
      liveCount++
    }
    docToOrd.set(docId, ord)
  }

  function calibrateFromVectors(vectors: Iterable<Float32Array>): void {
    const bounds = computeCalibrationBounds(vectors, dimensions)
    if (bounds === null) return

    constants = deriveSq8Constants(bounds.alpha, bounds.offset, dimensions)
    calibrated = true
  }

  function isOutsideBounds(vector: Float32Array): boolean {
    const currentMin = constants.offset
    const currentMax = constants.offset + constants.alpha * 255
    for (let d = 0; d < dimensions; d++) {
      if (vector[d] < currentMin || vector[d] > currentMax) {
        return true
      }
    }
    return false
  }

  function distanceScalar(
    queryQuantized: Uint8Array,
    querySum: number,
    queryMagnitude: number,
    ord: number,
    metric: VectorMetric,
  ): number {
    if (ord < 0 || ord >= capacity || present[ord] === 0) return Number.POSITIVE_INFINITY
    return scalarQuantizedDistance(
      quantizedArena,
      sums,
      mags,
      dimensions,
      constants,
      queryQuantized,
      querySum,
      queryMagnitude,
      ord,
      metric,
    )
  }

  return {
    get dimensions() {
      return dimensions
    },

    get size() {
      return liveCount
    },

    get calibration(): ScalarQuantizerCalibration | null {
      return calibrated ? { alpha: constants.alpha, offset: constants.offset } : null
    },

    isCalibrated(): boolean {
      return calibrated
    },

    calibrate(vectors: Iterable<Float32Array>): void {
      calibrateFromVectors(vectors)
    },

    needsRecalibration(vector: Float32Array): boolean {
      if (!calibrated) return false
      return isOutsideBounds(vector)
    },

    recalibrateAll(vectors: Iterable<[string, Float32Array]>): void {
      const collected: Array<[string, Float32Array]> = []
      const rawVectors: Float32Array[] = []
      for (const pair of vectors) {
        collected.push(pair)
        rawVectors.push(pair[1])
      }

      calibrateFromVectors(rawVectors)

      docToOrd.clear()
      present.fill(0)
      liveCount = 0

      for (const [docId, vec] of collected) {
        const ord = resolveOrdinal(docId)
        ensureCapacity(ord + 1)
        quantizeInto(ord, vec)
        storeEntry(docId, ord)
      }
    },

    quantize(docId: string, vector: Float32Array): void {
      if (!calibrated) {
        calibrateFromVectors([vector])
      }
      const ord = resolveOrdinal(docId)
      ensureCapacity(ord + 1)
      quantizeInto(ord, vector)
      storeEntry(docId, ord)
    },

    remove(docId: string): void {
      const ord = docToOrd.get(docId)
      if (ord === undefined) return
      docToOrd.delete(docId)
      if (present[ord] === 1) {
        present[ord] = 0
        liveCount--
      }
    },

    getQuantized(docId: string): Uint8Array | undefined {
      const ord = docToOrd.get(docId)
      if (ord === undefined || present[ord] === 0) return undefined
      const base = ord * dimensions
      return quantizedArena.subarray(base, base + dimensions)
    },

    prepareQuery(query: Float32Array): QuantizedQuery | null {
      if (!calibrated) return null
      const quantized = new Uint8Array(dimensions)
      const { sum, sumSq } = quantizeVectorInto(quantized, query, dimensions, constants)
      const mag = quantizedMagnitude(constants, sumSq, sum)
      return { quantized, sum, sumSq, magnitude: mag }
    },

    distanceFromPrepared(prepared: QuantizedQuery, docId: string, metric: VectorMetric): number {
      const ord = docToOrd.get(docId)
      if (ord === undefined) return Number.POSITIVE_INFINITY
      return distanceScalar(prepared.quantized, prepared.sum, prepared.magnitude, ord, metric)
    },

    distanceFromPreparedByOrdinal(prepared: QuantizedQuery, ordinal: number, metric: VectorMetric): number {
      return distanceScalar(prepared.quantized, prepared.sum, prepared.magnitude, ordinal, metric)
    },

    prepareQueryArena(query: Float32Array): ArenaQuery | null {
      if (!calibrated || !simd) return null
      const { sum, sumSq } = quantizeVectorInto(scratch, query, dimensions, constants)
      const magnitude = quantizedMagnitude(constants, sumSq, sum)
      return { sum, sumSq, magnitude }
    },

    distanceFromArena(prepared: ArenaQuery, ordinal: number, metric: VectorMetric): number {
      if (!simd || ordinal < 0 || ordinal >= capacity || present[ordinal] === 0) {
        return Number.POSITIVE_INFINITY
      }
      const arenaOffset = arenaByteOffset + ordinal * dimensions
      return arenaQuantizedDistance(
        simd,
        0,
        arenaOffset,
        dimensions,
        constants,
        prepared.sum,
        prepared.magnitude,
        sums[ordinal],
        mags[ordinal],
        metric,
      )
    },

    hasOrdinal(ordinal: number): boolean {
      return ordinal >= 0 && ordinal < capacity && present[ordinal] === 1
    },

    restoreCalibration(restoredAlpha: number, restoredOffset: number): void {
      constants = deriveSq8Constants(restoredAlpha, restoredOffset, dimensions)
      calibrated = true
    },

    restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void {
      const ord = resolveOrdinal(docId)
      ensureCapacity(ord + 1)
      const base = ord * dimensions
      quantizedArena.set(quantized.subarray(0, dimensions), base)
      sums[ord] = sum
      sumSqs[ord] = sumSq
      mags[ord] = quantizedMagnitude(constants, sumSq, sum)
      storeEntry(docId, ord)
    },

    copyStateInto(
      codes: Uint8Array,
      targetSums: Float64Array,
      targetSumSqs: Float64Array,
      targetMagnitudes: Float64Array,
      targetPresent: Uint8Array,
    ): void {
      const copySlots = Math.min(capacity, Math.floor(codes.length / dimensions))
      if (copySlots <= 0) return
      codes.set(quantizedArena.subarray(0, copySlots * dimensions))
      targetSums.set(sums.subarray(0, copySlots))
      targetSumSqs.set(sumSqs.subarray(0, copySlots))
      targetMagnitudes.set(mags.subarray(0, copySlots))
      targetPresent.set(present.subarray(0, copySlots))
    },

    serialize(): SerializedSQ8 {
      const serializedVectors: Record<string, number[]> = {}
      const serializedSums: Record<string, number> = {}
      const serializedSumSqs: Record<string, number> = {}
      for (const [docId, ord] of docToOrd) {
        if (present[ord] === 0) continue
        const base = ord * dimensions
        serializedVectors[docId] = Array.from(quantizedArena.subarray(base, base + dimensions))
        serializedSums[docId] = sums[ord]
        serializedSumSqs[docId] = sumSqs[ord]
      }
      return {
        alpha: constants.alpha,
        offset: constants.offset,
        quantizedVectors: serializedVectors,
        vectorSums: serializedSums,
        vectorSumSqs: serializedSumSqs,
      }
    },

    clear(): void {
      docToOrd.clear()
      if (!simd) {
        quantizedArena = new Uint8Array(0)
      }
      sums = new Float64Array(0)
      sumSqs = new Float64Array(0)
      mags = new Float64Array(0)
      present = new Uint8Array(0)
      capacity = 0
      selfNextOrd = 0
      liveCount = 0
      constants = deriveSq8Constants(0, 0, dimensions)
      calibrated = false
    },
  }
}
