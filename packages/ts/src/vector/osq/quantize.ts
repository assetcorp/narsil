import type { VectorMetric } from '../brute-force'
import { OSQ_GRID, OSQ_LAMBDA, OSQ_REFINE_ROUNDS, OSQ_REFINE_TOLERANCE, OSQ_STEPS } from './constants'

/**
 * Each dimension of a document code holds this many bits.
 *
 * @internal
 */
export type OsqBits = 1 | 2 | 4 | 8

/**
 * This is one vector quantised against the centroid: a level per dimension, the
 * interval the levels span, the correction the estimate adds back, and the
 * sum of the levels.
 *
 * @internal
 */
export interface OsqCode {
  levels: Uint8Array
  lower: number
  upper: number
  correction: number
  sum: number
}

/**
 * Reports the bits a quantisation mode holds per dimension, or null for a
 * mode that stores no code.
 *
 * @internal
 */
export function osqBitsOf(mode: string): OsqBits | null {
  switch (mode) {
    case 'osq8':
      return 8
    case 'osq4':
      return 4
    case 'osq2':
      return 2
    case 'osq1':
      return 1
    default:
      return null
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function unitNormaliseInto(target: Float64Array, vector: Float32Array): void {
  let squares = 0
  for (let i = 0; i < vector.length; i++) squares += vector[i] * vector[i]
  const length = Math.sqrt(squares)
  if (length === 0) {
    for (let i = 0; i < vector.length; i++) target[i] = vector[i]
    return
  }
  for (let i = 0; i < vector.length; i++) target[i] = vector[i] / length
}

/**
 * Computes the centroid every code is taken against, as the spec defines:
 * the mean of the vectors, each unit-normalised first under cosine, with the
 * mean itself unit-normalised under cosine.
 *
 * @param vectors The vectors to average.
 * @param dimension The components per vector.
 * @param metric The metric the field ranks by.
 * @returns The centroid, or null where the iterable held no vector.
 *
 * @internal
 */
export function osqCentroid(
  vectors: Iterable<Float32Array>,
  dimension: number,
  metric: VectorMetric,
): Float32Array | null {
  const sums = new Float64Array(dimension)
  const scratch = new Float64Array(dimension)
  let count = 0
  for (const vector of vectors) {
    if (metric === 'cosine') {
      unitNormaliseInto(scratch, vector)
      for (let i = 0; i < dimension; i++) sums[i] += scratch[i]
    } else {
      for (let i = 0; i < dimension; i++) sums[i] += vector[i]
    }
    count += 1
  }
  if (count === 0) return null
  const centroid = new Float32Array(dimension)
  if (metric === 'cosine') {
    let squares = 0
    for (let i = 0; i < dimension; i++) {
      sums[i] /= count
      squares += sums[i] * sums[i]
    }
    const length = Math.sqrt(squares)
    for (let i = 0; i < dimension; i++) centroid[i] = length === 0 ? sums[i] : sums[i] / length
    return centroid
  }
  for (let i = 0; i < dimension; i++) centroid[i] = sums[i] / count
  return centroid
}

function level(value: number, lower: number, upper: number, steps: number): number {
  if (upper === lower) return 0
  return Math.floor(((clamp(value, lower, upper) - lower) * steps) / (upper - lower) + 0.5)
}

function loss(x: Float64Array, lower: number, upper: number, steps: number, norm: number): number {
  let xe = 0
  let e = 0
  const width = (upper - lower) / steps
  for (let i = 0; i < x.length; i++) {
    const q = lower + width * level(x[i], lower, upper, steps)
    xe += x[i] * (x[i] - q)
    e += (x[i] - q) * (x[i] - q)
  }
  return ((1 - OSQ_LAMBDA) * xe * xe) / norm + OSQ_LAMBDA * e
}

function refine(x: Float64Array, lowerStart: number, upperStart: number, steps: number): [number, number] {
  let lower = lowerStart
  let upper = upperStart
  let norm = 0
  for (let i = 0; i < x.length; i++) norm += x[i] * x[i]
  if (norm === 0 || upper === lower) return [lower, upper]
  let best = loss(x, lower, upper, steps, norm)
  for (let round = 0; round < OSQ_REFINE_ROUNDS; round++) {
    let daa = 0
    let dab = 0
    let dbb = 0
    let dax = 0
    let dbx = 0
    for (let i = 0; i < x.length; i++) {
      const s = level(x[i], lower, upper, steps) / steps
      daa += (1 - s) * (1 - s)
      dab += (1 - s) * s
      dbb += s * s
      dax += x[i] * (1 - s)
      dbx += x[i] * s
    }
    const m0 = ((1 - OSQ_LAMBDA) * dax * dax) / norm + OSQ_LAMBDA * daa
    const m1 = ((1 - OSQ_LAMBDA) * dax * dbx) / norm + OSQ_LAMBDA * dab
    const m2 = ((1 - OSQ_LAMBDA) * dbx * dbx) / norm + OSQ_LAMBDA * dbb
    const det = m0 * m2 - m1 * m1
    if (det === 0) return [lower, upper]
    const a = (m2 * dax - m1 * dbx) / det
    const b = (m0 * dbx - m1 * dax) / det
    if (Math.abs(a - lower) < OSQ_REFINE_TOLERANCE && Math.abs(b - upper) < OSQ_REFINE_TOLERANCE) return [lower, upper]
    const candidate = loss(x, a, b, steps, norm)
    if (candidate > best) return [lower, upper]
    lower = a
    upper = b
    best = candidate
  }
  return [lower, upper]
}

/**
 * This is the working memory one thread reuses across quantisations, so a
 * build allocates nothing per vector.
 *
 * @internal
 */
export interface OsqScratch {
  normalised: Float64Array
  centred: Float64Array
}

/**
 * Builds the scratch a thread quantises with.
 *
 * @param dimension The components per vector.
 * @returns The scratch.
 *
 * @internal
 */
export function createOsqScratch(dimension: number): OsqScratch {
  return { normalised: new Float64Array(dimension), centred: new Float64Array(dimension) }
}

/**
 * Quantises one vector against the centroid, as the spec defines, at the
 * given bits per dimension.
 *
 * @param vector The vector to quantise.
 * @param centroid The centroid the field calibrated.
 * @param bits The bits each level holds.
 * @param metric The metric the field ranks by.
 * @param scratch The thread's working memory.
 * @returns The code, whose levels array the caller owns.
 *
 * @internal
 */
export function osqQuantize(
  vector: Float32Array,
  centroid: Float32Array,
  bits: OsqBits,
  metric: VectorMetric,
  scratch: OsqScratch,
): OsqCode {
  const dimension = vector.length
  const v = scratch.normalised
  if (metric === 'cosine') unitNormaliseInto(v, vector)
  else for (let i = 0; i < dimension; i++) v[i] = vector[i]
  const x = scratch.centred
  let correction = 0
  let total = 0
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (let i = 0; i < dimension; i++) {
    x[i] = v[i] - centroid[i]
    correction += metric === 'euclidean' ? x[i] * x[i] : v[i] * centroid[i]
    total += x[i]
    if (x[i] < minimum) minimum = x[i]
    if (x[i] > maximum) maximum = x[i]
  }
  const mean = total / dimension
  let spread = 0
  for (let i = 0; i < dimension; i++) spread += (x[i] - mean) * (x[i] - mean)
  const std = Math.sqrt(spread / dimension)
  const steps = OSQ_STEPS[bits]
  const [lower, upper] = refine(
    x,
    clamp(mean - OSQ_GRID[bits] * std, minimum, maximum),
    clamp(mean + OSQ_GRID[bits] * std, minimum, maximum),
    steps,
  )
  const levels = new Uint8Array(dimension)
  let sum = 0
  for (let i = 0; i < dimension; i++) {
    levels[i] = level(x[i], lower, upper, steps)
    sum += levels[i]
  }
  return { levels, lower, upper, correction, sum }
}
