import {
  allLiveDocIds,
  cosineSimilarityWithMagnitudes,
  dotProduct,
  ErrorCodes,
  euclideanDistance,
  filterForOptions,
  handOverBuildTurns,
  liveSize,
  magnitude,
  NarsilError,
  nativeScoresOf,
  noteFallback,
  ordinalFilterHas,
  ordinalFilterValues,
  toScore,
} from '#platform/vector-host'
import { type BinaryHeap, createBoundedMaxHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import type { OrdinalFilter } from '../ordinal-filter'
import { scheduleBuild } from './build'
import { highScoreFirst, mergeResults } from './merge-results'
import type { VectorIndexState, VectorScoredResult, VectorSearchOptions, VectorSearchOutcome } from './shared'

export function* bufferCandidates(
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

export function* filteredDocIds(state: VectorIndexState, filter: OrdinalFilter): Iterable<string> {
  for (const ordinal of ordinalFilterValues(filter)) {
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId !== undefined) yield docId
  }
}

interface ScanCandidates {
  docIds: string[]
  ordinals: number[]
}

export interface ScanOutcome {
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

export function liveOrdinalOf(
  state: VectorIndexState,
  docId: string,
  filter: OrdinalFilter | undefined,
): number | undefined {
  if (state.tombstones.has(docId)) return undefined
  const ordinal = state.store.getOrdinal(docId)
  if (ordinal === undefined || (filter !== undefined && !ordinalFilterHas(filter, ordinal))) return undefined
  return ordinal
}

function liveCandidates(
  state: VectorIndexState,
  candidates: Iterable<string>,
  filter: OrdinalFilter | undefined,
): ScanCandidates {
  const docIds: string[] = []
  const ordinals: number[] = []
  for (const docId of candidates) {
    const ordinal = liveOrdinalOf(state, docId, filter)
    if (ordinal === undefined) continue
    docIds.push(docId)
    ordinals.push(ordinal)
  }
  return { docIds, ordinals }
}

export interface ScanTally {
  readonly best: BinaryHeap<VectorScoredResult>
  readonly capacity: number
  matched: number
  bestDiscardedScore: number
}

export function createScanTally(capacity: number): ScanTally {
  return {
    best: createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, capacity),
    capacity,
    matched: 0,
    bestDiscardedScore: Number.NEGATIVE_INFINITY,
  }
}

function admitScore(tally: ScanTally, docId: string, score: number): void {
  tally.matched++
  const worst = tally.best.size < tally.capacity ? undefined : tally.best.peek()
  if (worst !== undefined && score < worst.score) {
    if (score > tally.bestDiscardedScore) tally.bestDiscardedScore = score
    return
  }
  const result = { docId, score }
  tally.best.push(result)
  if (worst === undefined) return
  const discarded = highScoreFirst(result, worst) < 0 ? worst.score : score
  if (discarded > tally.bestDiscardedScore) tally.bestDiscardedScore = discarded
}

export function scoreCandidates(
  state: VectorIndexState,
  query: Float32Array,
  metric: VectorMetric,
  minSimilarity: number,
  docIds: readonly string[],
  ordinals: ArrayLike<number>,
  tally: ScanTally,
): void {
  const count = ordinals.length
  const distances = nativeScoresOf(state.store.handles, query, metric, ordinals, state.store.writeSequence())
  if (distances !== null) {
    for (let i = 0; i < count; i++) {
      if (distances[i] === Number.POSITIVE_INFINITY) continue
      const score = toScore(distances[i], metric)
      if (score < minSimilarity) continue
      admitScore(tally, docIds[i], score)
    }
    return
  }
  noteFallback('score')

  const arenaQuery = state.store.prepareQueryArena(query)
  const queryMag = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  for (let i = 0; i < count; i++) {
    const docId = docIds[i]
    let score: number
    if (arenaQuery) {
      const distance = state.store.distanceFromArena(arenaQuery, ordinals[i], metric)
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
    admitScore(tally, docId, score)
  }
}

export function bruteForceSearch(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  candidates: Iterable<string>,
  filter?: OrdinalFilter,
): ScanOutcome {
  const scanned = liveCandidates(state, candidates, filter)
  const tally = createScanTally(k)
  scoreCandidates(state, query, metric, minSimilarity, scanned.docIds, scanned.ordinals, tally)
  return { results: tally.best.toSortedArray().reverse(), matched: tally.matched }
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

export interface ScanRequest {
  candidates: Iterable<string>
  filter: OrdinalFilter | undefined
  graphResults: VectorScoredResult[] | null
}

export type SearchSteps = Generator<ScanRequest, VectorSearchOutcome, ScanOutcome>

export function searchWithFilter(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
): VectorSearchOutcome {
  const steps = searchSteps(state, query, k, options, filter)
  let step = steps.next()
  while (step.done !== true) {
    const { candidates, filter: remaining } = step.value
    step = steps.next(bruteForceSearch(state, query, k, options.metric, options.minSimilarity, candidates, remaining))
  }
  return step.value
}

export function* searchSteps(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
): SearchSteps {
  if (query.length !== state.dimension) {
    throw new NarsilError(
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      `Vector dimension mismatch: expected ${state.dimension}, got ${query.length}`,
      { expected: state.dimension, received: query.length },
    )
  }

  const currentLiveSize = liveSize(state)
  const { minSimilarity } = options

  if (currentLiveSize === 0) return { results: [], matched: 0, matchedExact: true }
  if (filter && filter.count === 0) return { results: [], matched: 0, matchedExact: true }
  if (k <= 0) return fetchedOutcome(state, [], minSimilarity, filter)

  if (state.buffer.size > 0 && !state.building && !state.buildScheduled) {
    scheduleBuild(state)
  }

  if (!state.hnsw) {
    const candidates = filter ? filteredDocIds(state, filter) : allLiveDocIds(state)
    return scannedOutcome(yield { candidates, filter: undefined, graphResults: null })
  }

  if (filter) {
    const hnswLiveSize = state.hnsw.size
    const selectivity = hnswLiveSize > 0 ? filter.count / hnswLiveSize : 1
    if (selectivity < state.filterThreshold) {
      return scannedOutcome(yield { candidates: filteredDocIds(state, filter), filter: undefined, graphResults: null })
    }
  }

  const hnswResults = graphResultsOf(state, query, k, options, filter)
  if (state.buffer.size === 0) return fetchedOutcome(state, hnswResults, minSimilarity, filter)
  const scan = yield { candidates: state.buffer, filter, graphResults: hnswResults }
  return fetchedOutcome(state, mergeResults(hnswResults, scan.results, k), minSimilarity, filter)
}

export function graphResultsOf(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
): VectorScoredResult[] {
  if (state.hnsw === null) return []
  const { metric, minSimilarity, efSearch, oversample, rescoreWindow } = options
  return state.hnsw.search(query, k, metric, minSimilarity, { filter, efSearch, oversample, rescoreWindow })
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
  const scan = bruteForceSearch(state, query, k, options.metric, options.minSimilarity, buffered, filter)
  return mergeResults(graphResults, scan.results, k)
}
