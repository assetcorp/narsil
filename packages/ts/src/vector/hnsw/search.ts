import type { ScoredDocument } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import { magnitude } from '../similarity'
import { nearestFromHeap, searchLayer } from './graph-ops'
import {
  type DistancePair,
  entryForOrd,
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

  const liveSize = state.nodeCount - state.tombstoneCount
  if (state.entryPointOrd === -1 || liveSize === 0) {
    return []
  }

  const useQuantized = state.quantizer?.isCalibrated() === true && state.quantizer.size > 0
  const defaultEf = 50
  let ef = Math.max(efSearch ?? defaultEf, k)

  let filterOrds: Set<number> | undefined
  if (filterDocIds) {
    filterOrds = new Set<number>()
    for (const docId of filterDocIds) {
      const o = state.store.getOrdinal(docId)
      if (o !== undefined) filterOrds.add(o)
    }
    if (filterOrds.size < liveSize) {
      const selectivity = filterOrds.size / liveSize
      ef = Math.max(ef, Math.ceil(k / Math.max(selectivity, 0.01)))
      ef = Math.min(ef, liveSize)
    }
  }

  const qMag = magnitude(query)

  let quantizedDistFn: ((ord: number) => number) | undefined
  if (useQuantized && state.quantizer) {
    const q = state.quantizer
    const metric = searchMetric
    const arenaQuery = q.prepareQueryArena(query)
    if (arenaQuery) {
      quantizedDistFn = (ord: number) => q.distanceFromArena(arenaQuery, ord, metric)
    } else {
      const prepared = q.prepareQuery(query)
      if (prepared) {
        quantizedDistFn = (ord: number) => q.distanceFromPreparedByOrdinal(prepared, ord, metric)
      }
    }
  }

  let currentEPs = [state.entryPointOrd]

  for (let layer = state.topLayer; layer >= 1; layer--) {
    const heap = searchLayer(state, query, qMag, currentEPs, 1, layer, searchMetric, true, quantizedDistFn)
    const nearest = nearestFromHeap(heap)
    if (nearest) {
      currentEPs = [nearest.ord]
    }
  }

  const candidateHeap = searchLayer(state, query, qMag, currentEPs, ef, 0, searchMetric, true, quantizedDistFn)
  const candidateArray = candidateHeap.toSortedArray().reverse()

  if (useQuantized) {
    return rerankWithFullPrecision(state, candidateArray, query, qMag, k, searchMetric, minSimilarity, filterOrds)
  }

  const results: ScoredDocument[] = []
  for (const cand of candidateArray) {
    if (filterOrds && !filterOrds.has(cand.ord)) continue
    const score = toScore(cand.distance, searchMetric)
    if (score < minSimilarity) continue
    const docId = state.store.docIdForOrdinal(cand.ord)
    if (docId === undefined) continue
    results.push({
      docId,
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
  filterOrds?: Set<number>,
): ScoredDocument[] {
  const reranked: ScoredDocument[] = []
  const rerankLimit = Math.max(k * SQ8_OVERSELECTION_FACTOR, 10)

  for (const cand of candidates) {
    if (filterOrds && !filterOrds.has(cand.ord)) continue

    const entry = entryForOrd(state, cand.ord)
    if (!entry) continue

    const fullDistance = toDistance(query, entry.vector, qMag, entry.magnitude, metric)
    const score = toScore(fullDistance, metric)
    if (score < minSimilarity) continue

    const docId = state.store.docIdForOrdinal(cand.ord)
    if (docId === undefined) continue

    reranked.push({
      docId,
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
