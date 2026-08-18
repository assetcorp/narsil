import type { VectorMetric } from './brute-force'
import type { ArenaSimd } from './simd'

/**
 * The constants every SQ8 code and distance derives from, precomputed once
 * per calibration.
 *
 * The main thread's quantizer and a worker's read-only view both compute
 * through these, so a distance comes out identical on either side.
 *
 * @internal
 */
export interface Sq8Constants {
  /** Each step of the byte scale spans this much of the component range. */
  alpha: number
  /** The byte scale starts at this component value. */
  offset: number
  /** Alpha squared, applied to integer dot products. */
  alphaSquared: number
  /** Alpha times offset, applied to code sums. */
  alphaTimesOffset: number
  /** The dimension count times offset squared, a constant dot term. */
  dimensionsTimesOffsetSquared: number
  /** One over alpha, or zero when alpha is zero. */
  invAlpha: number
}

/**
 * Precomputes the derived quantisation constants for one calibration.
 *
 * @param alpha The scale of one byte step.
 * @param offset The component value the byte scale starts at.
 * @param dimensions The number of components per vector.
 * @returns The constants the quantisation formulas run on.
 *
 * @internal
 */
export function deriveSq8Constants(alpha: number, offset: number, dimensions: number): Sq8Constants {
  return {
    alpha,
    offset,
    alphaSquared: alpha * alpha,
    alphaTimesOffset: alpha * offset,
    dimensionsTimesOffsetSquared: dimensions * offset * offset,
    invAlpha: alpha > 0 ? 1 / alpha : 0,
  }
}

/**
 * Quantises a float32 vector into byte codes written to the target.
 *
 * @param target The byte destination, at least `dimensions` long.
 * @param vector The float32 vector to quantise.
 * @param dimensions The number of components to quantise.
 * @param constants The calibration constants to quantise with.
 * @returns The sum and squared sum of the produced codes.
 *
 * @internal
 */
export function quantizeVectorInto(
  target: Uint8Array,
  vector: Float32Array,
  dimensions: number,
  constants: Sq8Constants,
): { sum: number; sumSq: number } {
  const { offset, invAlpha } = constants
  let sum = 0
  let sumSq = 0
  for (let d = 0; d < dimensions; d++) {
    const normalized = (vector[d] - offset) * invAlpha
    const scaled = normalized + 0.5
    const q = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled | 0
    target[d] = q
    sum += q
    sumSq += q * q
  }
  return { sum, sumSq }
}

/**
 * Recovers a vector's magnitude from its code sums.
 *
 * @param constants The calibration constants the codes were derived with.
 * @param sumSq The squared sum of the vector's codes.
 * @param sum The sum of the vector's codes.
 * @returns The reconstructed magnitude, or zero when the value underflows.
 *
 * @internal
 */
export function quantizedMagnitude(constants: Sq8Constants, sumSq: number, sum: number): number {
  const val =
    constants.alphaSquared * sumSq + 2 * constants.alphaTimesOffset * sum + constants.dimensionsTimesOffsetSquared
  return val > 0 ? Math.sqrt(val) : 0
}

/**
 * Recovers a real dot product from an integer code dot product.
 *
 * @param constants The calibration constants the codes were derived with.
 * @param intDot The integer dot product of the two code vectors.
 * @param querySum The sum of the query's codes.
 * @param documentSum The sum of the document vector's codes.
 * @returns The reconstructed real dot product.
 *
 * @internal
 */
export function realDotFromInt(constants: Sq8Constants, intDot: number, querySum: number, documentSum: number): number {
  return (
    constants.alphaSquared * intDot +
    constants.alphaTimesOffset * (querySum + documentSum) +
    constants.dimensionsTimesOffsetSquared
  )
}

/**
 * Computes a quantised distance in plain JavaScript, for runtimes without the
 * SIMD kernels.
 *
 * @param codes The code arena, `dimensions` bytes per ordinal.
 * @param documentSums The per-ordinal code sums.
 * @param documentMagnitudes The per-ordinal reconstructed magnitudes.
 * @param dimensions The number of components per vector.
 * @param constants The calibration constants the codes were derived with.
 * @param queryQuantized The query's codes.
 * @param querySum The sum of the query's codes.
 * @param queryMagnitude The query's reconstructed magnitude.
 * @param ordinal The document ordinal to measure against.
 * @param metric The distance metric to compute.
 * @returns The distance under the metric.
 *
 * @internal
 */
export function scalarQuantizedDistance(
  codes: Uint8Array,
  documentSums: Float64Array,
  documentMagnitudes: Float64Array,
  dimensions: number,
  constants: Sq8Constants,
  queryQuantized: Uint8Array,
  querySum: number,
  queryMagnitude: number,
  ordinal: number,
  metric: VectorMetric,
): number {
  const base = ordinal * dimensions

  if (metric === 'euclidean') {
    let intSqDist = 0
    for (let d = 0; d < dimensions; d++) {
      const diff = queryQuantized[d] - codes[base + d]
      intSqDist += diff * diff
    }
    return constants.alpha * Math.sqrt(intSqDist)
  }

  let intDot = 0
  for (let d = 0; d < dimensions; d++) {
    intDot += queryQuantized[d] * codes[base + d]
  }

  const realDot = realDotFromInt(constants, intDot, querySum, documentSums[ordinal])

  if (metric === 'dotProduct') {
    return -realDot
  }

  const vecMag = documentMagnitudes[ordinal]
  if (!vecMag || vecMag === 0 || queryMagnitude === 0) return 1

  return 1 - realDot / (queryMagnitude * vecMag)
}

/**
 * Computes a quantised distance through the SIMD kernels, against codes
 * already resident in the kernel's memory.
 *
 * @param simd The kernel instance whose memory holds the codes.
 * @param queryByteOffset The byte offset of the quantised query.
 * @param codeByteOffset The byte offset of the document's codes.
 * @param dimensions The number of components per vector.
 * @param constants The calibration constants the codes were derived with.
 * @param querySum The sum of the query's codes.
 * @param queryMagnitude The query's reconstructed magnitude.
 * @param documentSum The sum of the document's codes.
 * @param documentMagnitude The document's reconstructed magnitude.
 * @param metric The distance metric to compute.
 * @returns The distance under the metric.
 *
 * @internal
 */
export function arenaQuantizedDistance(
  simd: ArenaSimd,
  queryByteOffset: number,
  codeByteOffset: number,
  dimensions: number,
  constants: Sq8Constants,
  querySum: number,
  queryMagnitude: number,
  documentSum: number,
  documentMagnitude: number,
  metric: VectorMetric,
): number {
  if (metric === 'euclidean') {
    const intSqDist = simd.sqdist_u8(queryByteOffset, codeByteOffset, dimensions)
    return constants.alpha * Math.sqrt(intSqDist)
  }

  const intDot = simd.dot_u8(queryByteOffset, codeByteOffset, dimensions)
  const realDot = realDotFromInt(constants, intDot, querySum, documentSum)

  if (metric === 'dotProduct') {
    return -realDot
  }

  if (!documentMagnitude || documentMagnitude === 0 || queryMagnitude === 0) return 1

  return 1 - realDot / (queryMagnitude * documentMagnitude)
}
