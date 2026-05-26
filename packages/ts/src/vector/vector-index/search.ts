import { createBoundedMaxHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../similarity'
import { scheduleBuild } from './build'
import {
  allLiveDocIds,
  liveSize,
  type VectorIndexState,
  type VectorScoredResult,
  type VectorSearchOptions,
} from './shared'

function* bufferCandidates(state: VectorIndexState, filterDocIds?: Set<string>): Iterable<string> {
  if (filterDocIds) {
    if (state.buffer.size <= filterDocIds.size) {
      for (const docId of state.buffer) {
        if (filterDocIds.has(docId) && !state.tombstones.has(docId)) yield docId
      }
    } else {
      for (const docId of filterDocIds) {
        if (state.buffer.has(docId) && !state.tombstones.has(docId)) yield docId
      }
    }
  } else {
    for (const docId of state.buffer) {
      if (!state.tombstones.has(docId)) yield docId
    }
  }
}

function bruteForceSearch(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  candidates: Iterable<string>,
): VectorScoredResult[] {
  const queryMag = magnitude(query)
  const highScoreFirst = (a: VectorScoredResult, b: VectorScoredResult) =>
    b.score - a.score || a.docId.localeCompare(b.docId)
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)

  for (const docId of candidates) {
    if (state.tombstones.has(docId)) continue
    const entry = state.store.get(docId)
    if (!entry) continue

    let score: number
    switch (metric) {
      case 'cosine':
        score = cosineSimilarityWithMagnitudes(query, entry.vector, queryMag, entry.magnitude)
        break
      case 'dotProduct':
        score = dotProduct(query, entry.vector)
        break
      case 'euclidean': {
        const dist = euclideanDistance(query, entry.vector)
        score = 1 / (1 + dist)
        break
      }
    }

    if (score >= minSimilarity) {
      heap.push({ docId, score })
    }
  }

  return heap.toSortedArray().reverse()
}

function mergeResults(
  hnswResults: VectorScoredResult[],
  bufferResults: VectorScoredResult[],
  k: number,
): VectorScoredResult[] {
  const seen = new Set<string>()
  const merged: VectorScoredResult[] = []
  let hi = 0
  let bi = 0

  while (merged.length < k && (hi < hnswResults.length || bi < bufferResults.length)) {
    const h = hi < hnswResults.length ? hnswResults[hi] : undefined
    const b = bi < bufferResults.length ? bufferResults[bi] : undefined

    let pick: VectorScoredResult
    if (h && b) {
      if (h.score > b.score || (h.score === b.score && h.docId.localeCompare(b.docId) < 0)) {
        pick = h
        hi++
      } else {
        pick = b
        bi++
      }
    } else if (h) {
      pick = h
      hi++
    } else if (b) {
      pick = b
      bi++
    } else {
      break
    }

    if (seen.has(pick.docId)) continue
    seen.add(pick.docId)
    merged.push(pick)
  }

  return merged
}

export function search(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
): VectorScoredResult[] {
  if (query.length !== state.dimension) {
    throw new Error(`Vector dimension mismatch: expected ${state.dimension}, got ${query.length}`)
  }

  const currentLiveSize = liveSize(state)
  if (currentLiveSize === 0) return []
  if (k <= 0) return []

  if (state.buffer.size > 0 && !state.building && !state.buildScheduled) {
    scheduleBuild(state)
  }

  const { metric, minSimilarity, filterDocIds, efSearch } = options

  if (filterDocIds && filterDocIds.size === 0) return []

  if (!state.hnsw) {
    const candidates = filterDocIds ?? allLiveDocIds(state)
    return bruteForceSearch(state, query, k, metric, minSimilarity, candidates)
  }

  if (state.buffer.size === 0) {
    if (filterDocIds) {
      const hnswLiveSize = state.hnsw.size
      const selectivity = hnswLiveSize > 0 ? filterDocIds.size / hnswLiveSize : 1
      if (selectivity < state.filterThreshold) {
        return bruteForceSearch(state, query, k, metric, minSimilarity, filterDocIds)
      }
    }

    const hnswResults = state.hnsw.search(query, k, metric, minSimilarity, filterDocIds, efSearch)
    return hnswResults.map(r => ({ docId: r.docId, score: r.score }))
  }

  if (filterDocIds) {
    const hnswLiveSize = state.hnsw.size
    const selectivity = hnswLiveSize > 0 ? filterDocIds.size / hnswLiveSize : 1
    if (selectivity < state.filterThreshold) {
      return bruteForceSearch(state, query, k, metric, minSimilarity, filterDocIds)
    }
  }

  const hnswResults = state.hnsw
    .search(query, k, metric, minSimilarity, filterDocIds, efSearch)
    .map(r => ({ docId: r.docId, score: r.score }))

  const bufferResults = bruteForceSearch(state, query, k, metric, minSimilarity, bufferCandidates(state, filterDocIds))

  return mergeResults(hnswResults, bufferResults, k)
}
