import { createBoundedMaxHeap } from '../../core/heap'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { toScore } from '../hnsw/shared'
import { noteFallback } from '../native/backend'
import { nativeScoresOf } from '../native/store'
import { type OrdinalFilter, ordinalFilterHas, ordinalFilterValues } from '../ordinal-filter'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../similarity'
import { scheduleBuild } from './build'
import { highScoreFirst, mergeResults } from './merge-results'
import {
  allLiveDocIds,
  filterForOptions,
  handOverBuildTurns,
  liveSize,
  type VectorIndexState,
  type VectorScoredResult,
  type VectorSearchOptions,
  type VectorSearchOutcome,
} from './shared'

function* bufferCandidates(
  state: VectorIndexState,
  buffered: Iterable<string>,
  filter?: OrdinalFilter,
): Iterable<string> {
  for (const docId of buffered) {
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

export function search(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
): VectorSearchOutcome {
  handOverBuildTurns(state)
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
  const { metric, minSimilarity, efSearch, oversample, rescoreWindow } = options

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

  const hnswResults = state.hnsw
    .search(query, k, metric, minSimilarity, { filter, efSearch, oversample, rescoreWindow })
    .map(r => ({ docId: r.docId, score: r.score }))

  const results =
    state.buffer.size === 0
      ? hnswResults
      : withBufferedVectors(state, query, k, options, filter, hnswResults, state.buffer)
  return fetchedOutcome(state, results, minSimilarity, filter)
}

export function withBufferedVectors(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
  graphResults: VectorScoredResult[],
  buffered: Iterable<string>,
): VectorScoredResult[] {
  const candidates = bufferCandidates(state, buffered, filter)
  const scan = bruteForceSearch(state, query, k, options.metric, options.minSimilarity, candidates)
  return mergeResults(graphResults, scan.results, k)
}
