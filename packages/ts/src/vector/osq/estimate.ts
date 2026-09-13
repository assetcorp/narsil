import type { VectorMetric } from '../brute-force'
import { OSQ_QUERY_BITS, OSQ_STEPS } from './constants'
import type { OsqBits } from './quantize'
import type { OsqTrailer } from './record'

const POPCOUNT = new Uint8Array(256)
for (let value = 0; value < 256; value++) {
  let count = 0
  let rest = value
  while (rest !== 0) {
    count += rest & 1
    rest >>= 1
  }
  POPCOUNT[value] = count
}

/**
 * Sums the products of two level arrays.
 *
 * @internal
 */
export function osqLevelProducts(a: Uint8Array, b: Uint8Array): number {
  let total = 0
  for (let i = 0; i < a.length; i++) total += a[i] * b[i]
  return total
}

/**
 * Sums the level products of two packed codes from their planes, as the
 * spec's popcount identity allows: `power(2, j + p)` times the set bits of
 * document plane `j` and query plane `p` together.
 *
 * @internal
 */
export function osqPackedLevelProducts(
  document: Uint8Array,
  documentOffset: number,
  documentBits: number,
  query: Uint8Array,
  queryOffset: number,
  queryBits: number,
  planeBytes: number,
): number {
  let total = 0
  for (let j = 0; j < documentBits; j++) {
    const documentPlane = documentOffset + j * planeBytes
    for (let p = 0; p < queryBits; p++) {
      const queryPlane = queryOffset + p * planeBytes
      let bitsSet = 0
      for (let n = 0; n < planeBytes; n++) bitsSet += POPCOUNT[document[documentPlane + n] & query[queryPlane + n]]
      total += 2 ** (j + p) * bitsSet
    }
  }
  return total
}

/**
 * Sums the products of an 8-bit code and an 8-bit query held as one byte
 * per level.
 *
 * @internal
 */
export function osqByteLevelProducts(
  document: Uint8Array,
  documentOffset: number,
  query: Uint8Array,
  queryOffset: number,
  dimension: number,
): number {
  let total = 0
  for (let i = 0; i < dimension; i++) total += document[documentOffset + i] * query[queryOffset + i]
  return total
}

/**
 * Estimates the similarity between a document code and a query code from
 * their trailers and the sum of their level products, as the spec defines.
 * The result is a similarity under cosine and dot product and a distance
 * under euclidean.
 *
 * @internal
 */
export function osqEstimate(
  products: number,
  document: OsqTrailer,
  documentBits: OsqBits,
  query: OsqTrailer,
  queryBits: OsqBits,
  dimension: number,
  centroidDot: number,
  metric: VectorMetric,
): number {
  const documentStep = (document.upper - document.lower) / OSQ_STEPS[documentBits]
  const queryStep = (query.upper - query.lower) / OSQ_STEPS[queryBits]
  const centred =
    document.lower * query.lower * dimension +
    query.lower * documentStep * document.sum +
    document.lower * queryStep * query.sum +
    documentStep * queryStep * products
  if (metric === 'euclidean') return Math.sqrt(Math.max(0, document.correction + query.correction - 2 * centred))
  const similarity = centred + document.correction + query.correction - centroidDot
  if (metric === 'cosine') return Math.min(Math.max(similarity, -1), 1)
  return similarity
}

/**
 * Turns an estimate into the distance the graph ranks by, where a smaller
 * value is nearer under every metric.
 *
 * @internal
 */
export function osqDistance(estimate: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine':
      return 1 - estimate
    case 'dotProduct':
      return -estimate
    case 'euclidean':
      return estimate
  }
}

/**
 * Reports the bits a query code holds against a document code of the given
 * bits.
 *
 * @internal
 */
export function osqQueryBits(bits: OsqBits): OsqBits {
  return OSQ_QUERY_BITS[bits]
}
