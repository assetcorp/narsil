import { createBoundedMaxHeap } from '../../core/heap'
import { compareCodePoints } from '../../core/ordering'
import type { VectorMetric } from '../brute-force'
import { toScore } from '../hnsw/shared'
import { type OrdinalFilter, ordinalFilterHas, ordinalFilterValues } from '../ordinal-filter'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../similarity'
import { scheduleBuild } from './build'
import {
  allLiveDocIds,
  filterForOptions,
  liveSize,
  type VectorIndexState,
  type VectorScoredResult,
  type VectorSearchOptions,
} from './shared'

function* bufferCandidates(state: VectorIndexState, filter?: OrdinalFilter): Iterable<string> {
  for (const docId of state.buffer) {
    if (state.tombstones.has(docId)) continue
    if (filter) {
      const ordinal = state.store.getOrdinal(docId)
      if (ordinal === undefined || !ordinalFilterHas(filter, ordinal)) continue
    }
    yield docId
  }
}

function* filteredDocIds(state: VectorIndexState, filter: OrdinalFilter): Iterable<string> {
  for (const ordinal of ordinalFilterValues(filter)) {
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId !== undefined) yield docId
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
  const arenaQuery = state.store.prepareQueryArena(query)
  const queryMag = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  const highScoreFirst = (a: VectorScoredResult, b: VectorScoredResult) =>
    b.score - a.score || compareCodePoints(a.docId, b.docId)
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)

  for (const docId of candidates) {
    if (state.tombstones.has(docId)) continue

    let score: number
    if (arenaQuery) {
      const ordinal = state.store.getOrdinal(docId)
      if (ordinal === undefined) continue
      const distance = state.store.distanceFromArena(arenaQuery, ordinal, metric)
      if (distance === Number.POSITIVE_INFINITY) continue
      score = toScore(distance, metric)
    } else {
      const entry = state.store.get(docId)
      if (!entry) continue

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
      if (h.score > b.score || (h.score === b.score && compareCodePoints(h.docId, b.docId) < 0)) {
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
  return searchWithFilter(state, query, k, options, filterForOptions(state, options))
}

export function searchWithFilter(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
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

  const { metric, minSimilarity, efSearch } = options

  if (filter && filter.count === 0) return []

  if (!state.hnsw) {
    const candidates = filter ? filteredDocIds(state, filter) : allLiveDocIds(state)
    return bruteForceSearch(state, query, k, metric, minSimilarity, candidates)
  }

  if (filter) {
    const hnswLiveSize = state.hnsw.size
    const selectivity = hnswLiveSize > 0 ? filter.count / hnswLiveSize : 1
    if (selectivity < state.filterThreshold) {
      return bruteForceSearch(state, query, k, metric, minSimilarity, filteredDocIds(state, filter))
    }
  }

  if (state.buffer.size === 0) {
    const hnswResults = state.hnsw.search(query, k, metric, minSimilarity, filter, efSearch)
    return hnswResults.map(r => ({ docId: r.docId, score: r.score }))
  }

  const hnswResults = state.hnsw
    .search(query, k, metric, minSimilarity, filter, efSearch)
    .map(r => ({ docId: r.docId, score: r.score }))

  const bufferResults = bruteForceSearch(state, query, k, metric, minSimilarity, bufferCandidates(state, filter))

  return mergeResults(hnswResults, bufferResults, k)
}
