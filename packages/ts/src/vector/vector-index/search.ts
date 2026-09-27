import { createBoundedMaxHeap } from '../../core/heap'
import { compareCodePoints } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { toScore } from '../hnsw/shared'
import { noteFallback } from '../native/backend'
import { nativeScoresOf } from '../native/store'
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
  type VectorSearchOutcome,
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

interface ScanCandidates {
  docIds: string[]
  ordinals: number[]
}

interface ScanOutcome {
  results: VectorScoredResult[]
  matched: number
}

function admittedTotal(state: VectorIndexState, filter: OrdinalFilter | undefined): number {
  return filter === undefined ? liveSize(state) : filter.count
}

export function fetchedOutcome(
  state: VectorIndexState,
  results: VectorScoredResult[],
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
): VectorSearchOutcome {
  if (minSimilarity === Number.NEGATIVE_INFINITY) {
    return { results, matched: admittedTotal(state, filter), matchedExact: true }
  }
  return { results, matched: results.length, matchedExact: false }
}

function scannedOutcome(scan: ScanOutcome): VectorSearchOutcome {
  return { results: scan.results, matched: scan.matched, matchedExact: true }
}

function highScoreFirst(a: VectorScoredResult, b: VectorScoredResult): number {
  return b.score - a.score || compareCodePoints(a.docId, b.docId)
}

function liveCandidates(state: VectorIndexState, candidates: Iterable<string>): ScanCandidates {
  const docIds: string[] = []
  const ordinals: number[] = []
  for (const docId of candidates) {
    if (state.tombstones.has(docId)) continue
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    docIds.push(docId)
    ordinals.push(ordinal)
  }
  return { docIds, ordinals }
}

function scanThroughTheCore(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  scanned: ScanCandidates,
): ScanOutcome | null {
  const distances = nativeScoresOf(state.store.handles, query, metric, scanned.ordinals)
  if (distances === null) return null
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)
  let matched = 0
  for (let i = 0; i < scanned.ordinals.length; i++) {
    if (distances[i] === Number.POSITIVE_INFINITY) continue
    const score = toScore(distances[i], metric)
    if (score < minSimilarity) continue
    matched++
    heap.push({ docId: scanned.docIds[i], score })
  }
  return { results: heap.toSortedArray().reverse(), matched }
}

function bruteForceSearch(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  candidates: Iterable<string>,
): ScanOutcome {
  const scanned = liveCandidates(state, candidates)
  const fromTheCore = scanThroughTheCore(state, query, k, metric, minSimilarity, scanned)
  if (fromTheCore !== null) return fromTheCore
  noteFallback('score')

  const arenaQuery = state.store.prepareQueryArena(query)
  const queryMag = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)
  let matched = 0

  for (let i = 0; i < scanned.docIds.length; i++) {
    const docId = scanned.docIds[i]
    let score: number
    if (arenaQuery) {
      const distance = state.store.distanceFromArena(arenaQuery, scanned.ordinals[i], metric)
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

    if (score < minSimilarity) continue
    matched++
    heap.push({ docId, score })
  }

  return { results: heap.toSortedArray().reverse(), matched }
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
): VectorSearchOutcome {
  return searchWithFilter(state, query, k, options, filterForOptions(state, options))
}

export function searchWithFilter(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
): VectorSearchOutcome {
  if (query.length !== state.dimension) {
    throw new NarsilError(
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      `Vector dimension mismatch: expected ${state.dimension}, got ${query.length}`,
      { expected: state.dimension, received: query.length },
    )
  }

  const currentLiveSize = liveSize(state)
  const { metric, minSimilarity, efSearch, oversample } = options

  if (currentLiveSize === 0) return { results: [], matched: 0, matchedExact: true }
  if (filter && filter.count === 0) return { results: [], matched: 0, matchedExact: true }
  if (k <= 0) return fetchedOutcome(state, [], minSimilarity, filter)

  if (state.buffer.size > 0 && !state.building && !state.buildScheduled) {
    scheduleBuild(state)
  }

  if (!state.hnsw) {
    const candidates = filter ? filteredDocIds(state, filter) : allLiveDocIds(state)
    return scannedOutcome(bruteForceSearch(state, query, k, metric, minSimilarity, candidates))
  }

  if (filter) {
    const hnswLiveSize = state.hnsw.size
    const selectivity = hnswLiveSize > 0 ? filter.count / hnswLiveSize : 1
    if (selectivity < state.filterThreshold) {
      const scan = bruteForceSearch(state, query, k, metric, minSimilarity, filteredDocIds(state, filter))
      return scannedOutcome(scan)
    }
  }

  const graphOptions = { filter, efSearch, oversample }
  if (state.buffer.size === 0) {
    const hnswResults = state.hnsw.search(query, k, metric, minSimilarity, graphOptions)
    return fetchedOutcome(
      state,
      hnswResults.map(r => ({ docId: r.docId, score: r.score })),
      minSimilarity,
      filter,
    )
  }

  const hnswResults = state.hnsw
    .search(query, k, metric, minSimilarity, graphOptions)
    .map(r => ({ docId: r.docId, score: r.score }))

  const buffered = bruteForceSearch(state, query, k, metric, minSimilarity, bufferCandidates(state, filter))

  return fetchedOutcome(state, mergeResults(hnswResults, buffered.results, k), minSimilarity, filter)
}
