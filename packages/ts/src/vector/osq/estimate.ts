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

export function osqLevelProducts(a: Uint8Array, b: Uint8Array): number {
  let total = 0
  for (let i = 0; i < a.length; i++) total += a[i] * b[i]
  return total
}

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

export function osqQueryBits(bits: OsqBits): OsqBits {
  return OSQ_QUERY_BITS[bits]
}
