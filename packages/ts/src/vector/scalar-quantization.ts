import type { VectorMetric } from './brute-force'
import { type ArenaSimd, createArenaSimd } from './simd'

export interface SerializedSQ8 {
  alpha: number
  offset: number
  quantizedVectors: Record<string, number[]>
  vectorSums: Record<string, number>
  vectorSumSqs: Record<string, number>
}

export interface QuantizedQuery {
  quantized: Uint8Array
  sum: number
  sumSq: number
  magnitude: number
}

export interface ArenaQuery {
  sum: number
  sumSq: number
  magnitude: number
}

export interface OrdinalSource {
  getOrdinal(docId: string): number | undefined
}

export interface ScalarQuantizer {
  quantize(docId: string, vector: Float32Array): void
  remove(docId: string): void
  getQuantized(docId: string): Uint8Array | undefined
  isCalibrated(): boolean
  calibrate(vectors: Iterable<Float32Array>): void
  needsRecalibration(vector: Float32Array): boolean
  recalibrateAll(vectors: Iterable<[string, Float32Array]>): void
  prepareQuery(query: Float32Array): QuantizedQuery | null
  distanceFromPrepared(prepared: QuantizedQuery, docId: string, metric: VectorMetric): number
  distanceFromPreparedByOrdinal(prepared: QuantizedQuery, ordinal: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQuery | null
  distanceFromArena(prepared: ArenaQuery, ordinal: number, metric: VectorMetric): number
  hasOrdinal(ordinal: number): boolean
  readonly dimensions: number
  readonly size: number
  serialize(): SerializedSQ8
  restoreCalibration(alpha: number, offset: number): void
  restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void
  clear(): void
}

const PADDING_FACTOR = 0.01
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

  let alpha = 0
  let offset = 0
  let alphaSquared = 0
  let alphaTimesOffset = 0
  let dTimesOffsetSquared = 0
  let invAlpha = 0
  let calibrated = false

  function updateDerivedConstants(): void {
    alphaSquared = alpha * alpha
    alphaTimesOffset = alpha * offset
    dTimesOffsetSquared = dimensions * offset * offset
    invAlpha = alpha > 0 ? 1 / alpha : 0
  }

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

  function computeMagnitude(sumSq: number, sum: number): number {
    const val = alphaSquared * sumSq + 2 * alphaTimesOffset * sum + dTimesOffsetSquared
    return val > 0 ? Math.sqrt(val) : 0
  }

  function quantizeInto(ord: number, vector: Float32Array): void {
    const base = ord * dimensions
    let sum = 0
    let sumSq = 0
    for (let d = 0; d < dimensions; d++) {
      const normalized = (vector[d] - offset) * invAlpha
      const scaled = normalized + 0.5
      const q = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled | 0
      quantizedArena[base + d] = q
      sum += q
      sumSq += q * q
    }
    sums[ord] = sum
    sumSqs[ord] = sumSq
    mags[ord] = computeMagnitude(sumSq, sum)
  }

  function storeEntry(docId: string, ord: number): void {
    if (present[ord] === 0) {
      present[ord] = 1
      liveCount++
    }
    docToOrd.set(docId, ord)
  }

  function calibrateFromVectors(vectors: Iterable<Float32Array>): void {
    let globalMin = Number.POSITIVE_INFINITY
    let globalMax = Number.NEGATIVE_INFINITY
    let count = 0

    for (const vec of vectors) {
      for (let d = 0; d < dimensions; d++) {
        const val = vec[d]
        if (val < globalMin) globalMin = val
        if (val > globalMax) globalMax = val
      }
      count++
    }

    if (count === 0) return

    const range = globalMax - globalMin
    const pad = range * PADDING_FACTOR
    globalMin -= pad
    globalMax += pad

    if (globalMin === globalMax) {
      globalMin -= 0.001
      globalMax += 0.001
    }

    alpha = (globalMax - globalMin) / 255
    offset = globalMin
    updateDerivedConstants()
    calibrated = true
  }

  function isOutsideBounds(vector: Float32Array): boolean {
    const currentMin = offset
    const currentMax = offset + alpha * 255
    for (let d = 0; d < dimensions; d++) {
      if (vector[d] < currentMin || vector[d] > currentMax) {
        return true
      }
    }
    return false
  }

  function realDotFromInt(intDot: number, querySum: number, ord: number): number {
    return alphaSquared * intDot + alphaTimesOffset * (querySum + sums[ord]) + dTimesOffsetSquared
  }

  function distanceScalar(
    queryQuantized: Uint8Array,
    querySum: number,
    queryMagnitude: number,
    ord: number,
    metric: VectorMetric,
  ): number {
    if (ord < 0 || ord >= capacity || present[ord] === 0) return Number.POSITIVE_INFINITY

    const base = ord * dimensions
    const dims = dimensions

    if (metric === 'euclidean') {
      let intSqDist = 0
      for (let d = 0; d < dims; d++) {
        const diff = queryQuantized[d] - quantizedArena[base + d]
        intSqDist += diff * diff
      }
      return alpha * Math.sqrt(intSqDist)
    }

    let intDot = 0
    for (let d = 0; d < dims; d++) {
      intDot += queryQuantized[d] * quantizedArena[base + d]
    }

    const realDot = realDotFromInt(intDot, querySum, ord)

    if (metric === 'dotProduct') {
      return -realDot
    }

    const vecMag = mags[ord]
    if (!vecMag || vecMag === 0 || queryMagnitude === 0) return 1

    return 1 - realDot / (queryMagnitude * vecMag)
  }

  function quantizeQueryInto(target: Uint8Array, query: Float32Array): { sum: number; sumSq: number } {
    let sum = 0
    let sumSq = 0
    for (let d = 0; d < dimensions; d++) {
      const normalized = (query[d] - offset) * invAlpha
      const scaled = normalized + 0.5
      const q = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled | 0
      target[d] = q
      sum += q
      sumSq += q * q
    }
    return { sum, sumSq }
  }

  return {
    get dimensions() {
      return dimensions
    },

    get size() {
      return liveCount
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
      const { sum, sumSq } = quantizeQueryInto(quantized, query)
      const mag = computeMagnitude(sumSq, sum)
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
      const { sum, sumSq } = quantizeQueryInto(scratch, query)
      const magnitude = computeMagnitude(sumSq, sum)
      return { sum, sumSq, magnitude }
    },

    distanceFromArena(prepared: ArenaQuery, ordinal: number, metric: VectorMetric): number {
      if (!simd || ordinal < 0 || ordinal >= capacity || present[ordinal] === 0) {
        return Number.POSITIVE_INFINITY
      }
      const arenaOffset = arenaByteOffset + ordinal * dimensions

      if (metric === 'euclidean') {
        const intSqDist = simd.sqdist_u8(0, arenaOffset, dimensions)
        return alpha * Math.sqrt(intSqDist)
      }

      const intDot = simd.dot_u8(0, arenaOffset, dimensions)
      const realDot = realDotFromInt(intDot, prepared.sum, ordinal)

      if (metric === 'dotProduct') {
        return -realDot
      }

      const vecMag = mags[ordinal]
      if (!vecMag || vecMag === 0 || prepared.magnitude === 0) return 1

      return 1 - realDot / (prepared.magnitude * vecMag)
    },

    hasOrdinal(ordinal: number): boolean {
      return ordinal >= 0 && ordinal < capacity && present[ordinal] === 1
    },

    restoreCalibration(restoredAlpha: number, restoredOffset: number): void {
      alpha = restoredAlpha
      offset = restoredOffset
      updateDerivedConstants()
      calibrated = true
    },

    restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void {
      const ord = resolveOrdinal(docId)
      ensureCapacity(ord + 1)
      const base = ord * dimensions
      quantizedArena.set(quantized.subarray(0, dimensions), base)
      sums[ord] = sum
      sumSqs[ord] = sumSq
      mags[ord] = computeMagnitude(sumSq, sum)
      storeEntry(docId, ord)
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
        alpha,
        offset,
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
      alpha = 0
      offset = 0
      alphaSquared = 0
      alphaTimesOffset = 0
      dTimesOffsetSquared = 0
      invAlpha = 0
      calibrated = false
    },
  }
}

export function deserializeScalarQuantizer(
  data: SerializedSQ8,
  dimensions: number,
  ordinalSource?: OrdinalSource,
): ScalarQuantizer {
  const quantizer = createScalarQuantizer(dimensions, ordinalSource)

  if (data.alpha === 0 && data.offset === 0 && Object.keys(data.quantizedVectors).length === 0) {
    return quantizer
  }

  quantizer.restoreCalibration(data.alpha, data.offset)

  for (const [docId, values] of Object.entries(data.quantizedVectors)) {
    const quantized = new Uint8Array(values)
    const sum = data.vectorSums[docId] ?? 0
    const sumSq = data.vectorSumSqs[docId] ?? 0
    quantizer.restoreEntry(docId, quantized, sum, sumSq)
  }

  return quantizer
}
