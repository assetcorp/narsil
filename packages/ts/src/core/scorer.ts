import type { BM25Params } from '../types/schema'

const DEFAULT_K1 = 1.2
const DEFAULT_B = 0.75

export function computeIDF(docFrequency: number, totalDocs: number): number {
  if (totalDocs === 0) return 0
  return Math.log((totalDocs - docFrequency + 0.5) / (docFrequency + 0.5) + 1)
}

/**
 * Reports whether block pruning may trust its score bound under these BM25
 * parameters. The bound takes a block's highest term frequency and shortest
 * field length as the best case, which holds only while the score never falls
 * as term frequency grows and never rises as field length grows: `k1` at or
 * above zero and finite, and `b` between zero and one. Outside that range the
 * pruned scan must stand down and the query runs on the unpruned loop.
 *
 * @param params - The index's BM25 parameters; absent values take the defaults.
 * @returns True when the pruned scan's block bound is a true upper bound.
 */
export function bm25PruningSound(params?: BM25Params): boolean {
  const k1 = params?.k1 ?? DEFAULT_K1
  const b = params?.b ?? DEFAULT_B
  return Number.isFinite(k1) && k1 >= 0 && b >= 0 && b <= 1
}

export function computeBM25(
  termFrequency: number,
  docFrequency: number,
  totalDocs: number,
  fieldLength: number,
  avgFieldLength: number,
  params?: BM25Params,
): number {
  if (totalDocs === 0) return 0
  if (avgFieldLength === 0) return 0

  const k1 = params?.k1 ?? DEFAULT_K1
  const b = params?.b ?? DEFAULT_B

  const idf = computeIDF(docFrequency, totalDocs)
  const numerator = termFrequency * (k1 + 1)
  const denominator = termFrequency + k1 * (1 - b + (b * fieldLength) / avgFieldLength)

  if (denominator === 0) return 0
  return idf * (numerator / denominator)
}

export function computeBM25WithGlobalStats(
  termFrequency: number,
  globalDocFrequency: number,
  globalTotalDocs: number,
  fieldLength: number,
  globalAvgFieldLength: number,
  params?: BM25Params,
): number {
  return computeBM25(termFrequency, globalDocFrequency, globalTotalDocs, fieldLength, globalAvgFieldLength, params)
}
