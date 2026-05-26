import type { ScoredDocument } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import type { QuantizedQuery } from '../scalar-quantization'
import { magnitude } from '../similarity'
import { nearestFromHeap, searchLayer } from './graph-ops'
import {
  type DistancePair,
  getEntry,
  type HNSWGraphState,
  SQ8_OVERSELECTION_FACTOR,
  toDistance,
  toScore,
} from './shared'

export function search(
  state: HNSWGraphState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  filterDocIds?: Set<string>,
  efSearch?: number,
): ScoredDocument[] {
  if (query.length !== state.dimension) {
    throw new Error(`Query dimension mismatch: expected ${state.dimension}, got ${query.length}`)
  }

  const liveSize = state.nodes.size - state.tombstones.size
  if (state.entryPointId === null || liveSize === 0) {
    return []
  }

  const useQuantized = state.quantizer?.isCalibrated() === true && state.quantizer.size > 0
  const defaultEf = 50
  let ef = Math.max(efSearch ?? defaultEf, k)
  if (filterDocIds && filterDocIds.size < liveSize) {
    const selectivity = filterDocIds.size / liveSize
    ef = Math.max(ef, Math.ceil(k / Math.max(selectivity, 0.01)))
    ef = Math.min(ef, liveSize)
  }

  const qMag = magnitude(query)

  let quantizedDistFn: ((nodeId: string) => number) | undefined
  let prepared: QuantizedQuery | null = null
  if (useQuantized && state.quantizer) {
    prepared = state.quantizer.prepareQuery(query)
    if (prepared) {
      const p = prepared
      const metric = searchMetric
      const q = state.quantizer
      quantizedDistFn = (nodeId: string) => q.distanceFromPrepared(p, nodeId, metric)
    }
  }

  let currentEPs = [state.entryPointId]

  for (let layer = state.topLayer; layer >= 1; layer--) {
    const heap = searchLayer(state, query, qMag, currentEPs, 1, layer, searchMetric, true, quantizedDistFn)
    const nearest = nearestFromHeap(heap)
    if (nearest) {
      currentEPs = [nearest.docId]
    }
  }

  const candidateHeap = searchLayer(state, query, qMag, currentEPs, ef, 0, searchMetric, true, quantizedDistFn)
  const candidateArray = candidateHeap.toSortedArray().reverse()

  if (useQuantized) {
    return rerankWithFullPrecision(state, candidateArray, query, qMag, k, searchMetric, minSimilarity, filterDocIds)
  }

  const results: ScoredDocument[] = []
  for (const cand of candidateArray) {
    if (filterDocIds && !filterDocIds.has(cand.docId)) continue
    const score = toScore(cand.distance, searchMetric)
    if (score < minSimilarity) continue
    results.push({
      docId: cand.docId,
      score,
      termFrequencies: {},
      fieldLengths: {},
      idf: {},
    })
  }

  results.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
  return results.slice(0, k)
}

function rerankWithFullPrecision(
  state: HNSWGraphState,
  candidates: DistancePair[],
  query: Float32Array,
  qMag: number,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  filterDocIds?: Set<string>,
): ScoredDocument[] {
  const reranked: ScoredDocument[] = []
  const rerankLimit = Math.max(k * SQ8_OVERSELECTION_FACTOR, 10)

  for (const cand of candidates) {
    if (filterDocIds && !filterDocIds.has(cand.docId)) continue

    const entry = getEntry(state, cand.docId)
    if (!entry) continue

    const fullDistance = toDistance(query, entry.vector, qMag, entry.magnitude, metric)
    const score = toScore(fullDistance, metric)
    if (score < minSimilarity) continue

    reranked.push({
      docId: cand.docId,
      score,
      termFrequencies: {},
      fieldLengths: {},
      idf: {},
    })

    if (reranked.length >= rerankLimit) break
  }

  reranked.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
  return reranked.slice(0, k)
}
