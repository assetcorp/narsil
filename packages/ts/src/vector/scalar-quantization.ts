import type { VectorMetric } from './brute-force'

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
  readonly dimensions: number
  readonly size: number
  serialize(): SerializedSQ8
  restoreCalibration(alpha: number, offset: number): void
  restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void
  clear(): void
}

const PADDING_FACTOR = 0.01

export function createScalarQuantizer(dimensions: number): ScalarQuantizer {
  const quantizedVectors = new Map<string, Uint8Array>()
  const vectorSums = new Map<string, number>()
  const vectorSumSqs = new Map<string, number>()
  const dequantizedMagnitudes = new Map<string, number>()

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

  function computeMagnitude(sumSq: number, sum: number): number {
    const val = alphaSquared * sumSq + 2 * alphaTimesOffset * sum + dTimesOffsetSquared
    return val > 0 ? Math.sqrt(val) : 0
  }

  function quantizeVector(vector: Float32Array): Uint8Array {
    const result = new Uint8Array(dimensions)
    for (let d = 0; d < dimensions; d++) {
      const normalized = (vector[d] - offset) * invAlpha
      const scaled = normalized + 0.5
      result[d] = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled | 0
    }
    return result
  }

  function computeSumAndSumSq(quantized: Uint8Array): { sum: number; sumSq: number } {
    let sum = 0
    let sumSq = 0
    for (let d = 0; d < dimensions; d++) {
      const val = quantized[d]
      sum += val
      sumSq += val * val
    }
    return { sum, sumSq }
  }

  function storeQuantized(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void {
    quantizedVectors.set(docId, quantized)
    vectorSums.set(docId, sum)
    vectorSumSqs.set(docId, sumSq)
    dequantizedMagnitudes.set(docId, computeMagnitude(sumSq, sum))
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

  return {
    get dimensions() {
      return dimensions
    },

    get size() {
      return quantizedVectors.size
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

      quantizedVectors.clear()
      vectorSums.clear()
      vectorSumSqs.clear()
      dequantizedMagnitudes.clear()

      for (const [docId, vec] of collected) {
        const quantized = quantizeVector(vec)
        const { sum, sumSq } = computeSumAndSumSq(quantized)
        storeQuantized(docId, quantized, sum, sumSq)
      }
    },

    quantize(docId: string, vector: Float32Array): void {
      if (!calibrated) {
        calibrateFromVectors([vector])
      }
      const quantized = quantizeVector(vector)
      const { sum, sumSq } = computeSumAndSumSq(quantized)
      storeQuantized(docId, quantized, sum, sumSq)
    },

    remove(docId: string): void {
      quantizedVectors.delete(docId)
      vectorSums.delete(docId)
      vectorSumSqs.delete(docId)
      dequantizedMagnitudes.delete(docId)
    },

    getQuantized(docId: string): Uint8Array | undefined {
      return quantizedVectors.get(docId)
    },

    prepareQuery(query: Float32Array): QuantizedQuery | null {
      if (!calibrated) return null
      const quantized = quantizeVector(query)
      const { sum, sumSq } = computeSumAndSumSq(quantized)
      const mag = computeMagnitude(sumSq, sum)
      return { quantized, sum, sumSq, magnitude: mag }
    },

    distanceFromPrepared(prepared: QuantizedQuery, docId: string, metric: VectorMetric): number {
      const vecQ = quantizedVectors.get(docId)
      if (!vecQ) return Number.POSITIVE_INFINITY

      const vecSum = vectorSums.get(docId)
      const vecSumSq = vectorSumSqs.get(docId)
      if (vecSum === undefined || vecSumSq === undefined) return Number.POSITIVE_INFINITY

      const qQ = prepared.quantized
      const dims = dimensions

      if (metric === 'euclidean') {
        let intSqDist = 0
        for (let d = 0; d < dims; d++) {
          const diff = qQ[d] - vecQ[d]
          intSqDist += diff * diff
        }
        return alpha * Math.sqrt(intSqDist)
      }

      let intDot = 0
      for (let d = 0; d < dims; d++) {
        intDot += qQ[d] * vecQ[d]
      }

      const realDot = alphaSquared * intDot + alphaTimesOffset * (prepared.sum + vecSum) + dTimesOffsetSquared

      if (metric === 'dotProduct') {
        return -realDot
      }

      const vecMag = dequantizedMagnitudes.get(docId)
      if (!vecMag || vecMag === 0 || prepared.magnitude === 0) return 1

      return 1 - realDot / (prepared.magnitude * vecMag)
    },

    restoreCalibration(restoredAlpha: number, restoredOffset: number): void {
      alpha = restoredAlpha
      offset = restoredOffset
      updateDerivedConstants()
      calibrated = true
    },

    restoreEntry(docId: string, quantized: Uint8Array, sum: number, sumSq: number): void {
      storeQuantized(docId, quantized, sum, sumSq)
    },

    serialize(): SerializedSQ8 {
      const serializedVectors: Record<string, number[]> = {}
      const serializedSums: Record<string, number> = {}
      const serializedSumSqs: Record<string, number> = {}
      for (const [docId, qv] of quantizedVectors) {
        serializedVectors[docId] = Array.from(qv)
        const sum = vectorSums.get(docId)
        const sumSq = vectorSumSqs.get(docId)
        if (sum !== undefined) serializedSums[docId] = sum
        if (sumSq !== undefined) serializedSumSqs[docId] = sumSq
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
      quantizedVectors.clear()
      vectorSums.clear()
      vectorSumSqs.clear()
      dequantizedMagnitudes.clear()
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

export function deserializeScalarQuantizer(data: SerializedSQ8, dimensions: number): ScalarQuantizer {
  const quantizer = createScalarQuantizer(dimensions)

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
