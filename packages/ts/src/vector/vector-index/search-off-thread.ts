import { turnIsSpent, yieldTurn } from '#platform/turn-budget'
import { createBoundedMaxHeap } from '../../core/heap'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { NATIVE_THREAD_SCAN_CHUNK_ORDINALS } from '../constants'
import { toScore } from '../hnsw/shared'
import { nativeMetricCode, nativeStoreFor } from '../native/store'
import { type ThreadedNativeCore, threadedNativeCore, withNativeThreadSlot } from '../native/thread-slots'
import { NATIVE_OK } from '../native/types'
import type { OrdinalFilter } from '../ordinal-filter'
import { scheduleBuild } from './build'
import { highScoreFirst, mergeResults } from './merge-results'
import { bufferCandidates, fetchedOutcome, filteredDocIds } from './search'
import { layoutGeneration, searchFiltered } from './search-in-turns'
import { watchingSearch } from './search-writes'
import {
  allLiveDocIds,
  filterForOptions,
  liveSize,
  type VectorIndexState,
  type VectorScoredResult,
  type VectorSearchOptions,
  type VectorSearchOutcome,
} from './shared'

interface ScanOutcome {
  results: VectorScoredResult[]
  matched: number
}

interface OffThreadSearch {
  state: VectorIndexState
  core: ThreadedNativeCore
  query: Float32Array
  k: number
  options: VectorSearchOptions
  filter: OrdinalFilter | undefined
  confinedAtRevision: number | null
}

function currentFilter(search: OffThreadSearch): OrdinalFilter | undefined {
  const { state, options, filter, confinedAtRevision } = search
  if (confinedAtRevision === null || state.revision === confinedAtRevision) return filter
  return filterForOptions(state, options)
}

async function scoredChunk(
  search: OffThreadSearch,
  metric: VectorMetric,
  ordinals: Int32Array,
  count: number,
): Promise<Float64Array | null> {
  const store = nativeStoreFor(search.state.store.handles)
  if (store === null) return null
  try {
    const scored = await withNativeThreadSlot(slot =>
      search.core.scoreAsync(store.handle, search.query, nativeMetricCode(metric), ordinals, count, slot),
    )
    return scored.status === NATIVE_OK ? scored.distances : null
  } catch {
    return null
  }
}

async function scanOffThread(search: OffThreadSearch, candidates: Iterable<string>): Promise<ScanOutcome | null> {
  const { state, k, options } = search
  const { metric, minSimilarity } = options
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)
  let matched = 0
  const docIds: string[] = []
  const ordinals = new Int32Array(NATIVE_THREAD_SCAN_CHUNK_ORDINALS)
  const remaining = candidates[Symbol.iterator]()
  let exhausted = false
  while (!exhausted) {
    docIds.length = 0
    while (docIds.length < NATIVE_THREAD_SCAN_CHUNK_ORDINALS) {
      if (turnIsSpent()) await yieldTurn()
      const next = remaining.next()
      if (next.done === true) {
        exhausted = true
        break
      }
      if (state.tombstones.has(next.value)) continue
      const ordinal = state.store.getOrdinal(next.value)
      if (ordinal === undefined) continue
      ordinals[docIds.length] = ordinal
      docIds.push(next.value)
    }
    if (docIds.length === 0) break
    const distances = await scoredChunk(search, metric, ordinals, docIds.length)
    if (distances === null) return null
    for (let i = 0; i < docIds.length; i++) {
      if (distances[i] === Number.POSITIVE_INFINITY) continue
      const score = toScore(distances[i], metric)
      if (score < minSimilarity) continue
      matched++
      heap.push({ docId: docIds[i], score })
    }
  }
  return { results: heap.toSortedArray().reverse(), matched }
}

function scansEveryCandidate(state: VectorIndexState, filter: OrdinalFilter | undefined): boolean {
  if (state.hnsw === null) return true
  if (filter === undefined) return false
  const graphSize = state.hnsw.size
  const selectivity = graphSize > 0 ? filter.count / graphSize : 1
  return selectivity < state.filterThreshold
}

async function outcomeOffThread(search: OffThreadSearch): Promise<VectorSearchOutcome | null> {
  const { state, query, k, options, filter } = search
  const { metric, minSimilarity, efSearch, oversample, rescoreWindow } = options
  const graph = state.hnsw
  if (graph === null || scansEveryCandidate(state, filter)) {
    const candidates = filter ? filteredDocIds(state, filter) : allLiveDocIds(state)
    const scan = await scanOffThread(search, candidates)
    return scan === null ? null : { results: scan.results, matched: scan.matched, matchedExact: true }
  }

  const buffered = state.buffer.size === 0 ? null : [...state.buffer]
  const hits = await graph.searchOffThread(query, k, metric, minSimilarity, {
    filter,
    efSearch,
    oversample,
    rescoreWindow,
  })
  if (hits === null) return null
  const graphResults = hits.map(hit => ({ docId: hit.docId, score: hit.score }))
  if (buffered === null) return fetchedOutcome(state, graphResults, minSimilarity, currentFilter(search))
  const scan = await scanOffThread(search, bufferCandidates(state, buffered, filter))
  if (scan === null) return null
  return fetchedOutcome(state, mergeResults(graphResults, scan.results, k), minSimilarity, currentFilter(search))
}

async function searchOnNativeThreads(search: OffThreadSearch): Promise<VectorSearchOutcome> {
  const { state, query, k, options, filter } = search
  if (query.length !== state.dimension) {
    throw new NarsilError(
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      `Vector dimension mismatch: expected ${state.dimension}, got ${query.length}`,
      { expected: state.dimension, received: query.length },
    )
  }
  if (liveSize(state) === 0) return { results: [], matched: 0, matchedExact: true }
  if (filter && filter.count === 0) return { results: [], matched: 0, matchedExact: true }
  if (k <= 0) return fetchedOutcome(state, [], options.minSimilarity, filter)
  if (state.buffer.size > 0 && !state.building && !state.buildScheduled) scheduleBuild(state)

  const generation = layoutGeneration(state)
  const settled = await watchingSearch(state, async watch => {
    const outcome = await outcomeOffThread(search)
    if (outcome === null || watch.written.size > 0 || layoutGeneration(state) !== generation) return null
    return outcome
  })
  return settled ?? searchFiltered(state, query, k, options, filterForOptions(state, options))
}

export function searchOffThread(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  filter: OrdinalFilter | undefined,
  confinedAtRevision: number | null,
): Promise<VectorSearchOutcome> | null {
  const core = threadedNativeCore()
  if (core === null) return null
  return searchOnNativeThreads({ state, core, query, k, options, filter, confinedAtRevision })
}
