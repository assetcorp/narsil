import {
  admissionAt,
  allLiveDocIds,
  ErrorCodes,
  filterForOptions,
  liveSize,
  NATIVE_OK,
  NATIVE_THREAD_SCAN_CHUNK_ORDINALS,
  NarsilError,
  nativeMetricCode,
  nativeStoreFor,
  storePinsOf,
  threadedNativeCore,
  toScore,
  turnIsSpent,
  withNativeThreadSlot,
  yieldTurn,
} from '#platform/vector-host'
import { createBoundedMaxHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import type { ThreadedNativeCore } from '../native/thread-slots'
import type { OrdinalFilter } from '../ordinal-filter'
import type { OrdinalAdmission } from '../vector-store/admission'
import { scheduleBuild } from './build'
import { highScoreFirst, mergeResults } from './merge-results'
import { bufferCandidates, fetchedOutcome, filteredDocIds } from './search'
import { layoutGeneration, searchFiltered } from './search-in-turns'
import { watchingSearch } from './search-writes'
import type { VectorIndexState, VectorScoredResult, VectorSearchOptions, VectorSearchOutcome } from './shared'

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

interface PinnedOffThreadSearch extends OffThreadSearch {
  admission: OrdinalAdmission
}

function currentFilter(search: OffThreadSearch): OrdinalFilter | undefined {
  const { state, options, filter, confinedAtRevision } = search
  if (confinedAtRevision === null || state.revision === confinedAtRevision) return filter
  return filterForOptions(state, options)
}

async function scoredChunk(
  search: PinnedOffThreadSearch,
  metric: VectorMetric,
  ordinals: Int32Array,
  count: number,
): Promise<Float64Array | null> {
  const store = nativeStoreFor(search.state.store.handles)
  if (store === null) return null
  try {
    const code = nativeMetricCode(metric)
    const pin = search.admission.pin
    const scored = await withNativeThreadSlot(slot =>
      search.core.scoreAsync(store.handle, search.query, code, ordinals, count, pin, slot),
    )
    return scored.status === NATIVE_OK ? scored.distances : null
  } catch {
    return null
  }
}

async function scanOffThread(search: PinnedOffThreadSearch, candidates: Iterable<string>): Promise<ScanOutcome | null> {
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

async function outcomeOffThread(search: PinnedOffThreadSearch): Promise<VectorSearchOutcome | null> {
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
    admission: search.admission,
  })
  if (hits === null) return null
  if (buffered === null) return fetchedOutcome(state, hits, minSimilarity, currentFilter(search))
  const scan = await scanOffThread(search, bufferCandidates(state, buffered, filter))
  if (scan === null) return null
  return fetchedOutcome(state, mergeResults(hits, scan.results, k), minSimilarity, currentFilter(search))
}

async function searchOnNativeThreads(search: OffThreadSearch): Promise<VectorSearchOutcome> {
  const { state, core, query, k, options, filter, confinedAtRevision } = search
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
    const view = state.store.view
    const pins = storePinsOf(view)
    const pin = pins.take()
    try {
      const outcome = await outcomeOffThread({
        state,
        core,
        query,
        k,
        options,
        filter,
        confinedAtRevision,
        admission: admissionAt(view, pin),
      })
      if (outcome === null || watch.written.size > 0 || layoutGeneration(state) !== generation) return null
      return outcome
    } finally {
      pins.release(pin)
    }
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
