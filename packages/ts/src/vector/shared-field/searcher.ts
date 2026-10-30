import { createBoundedMaxHeap } from '../../core/heap'
import { type SearchClock, STEADY_CLOCK } from '../../core/search-clock'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { MAX_RENUMBERED_SEARCH_ATTEMPTS } from '../constants'
import { type OrdinalSpace, ordinalFilterForSubsets } from '../filter-ordinals'
import { toDistance, toScore } from '../hnsw/shared'
import { noteFallback } from '../native/backend'
import { nativeScoresOf } from '../native/store'
import {
  addToOrdinalFilter,
  createOrdinalFilter,
  type OrdinalFilter,
  ordinalFilterHas,
  ordinalFilterValues,
} from '../ordinal-filter'
import { magnitude } from '../similarity'
import { highScoreFirst, mergeResults } from '../vector-index/merge-results'
import type {
  VectorScoredResult,
  VectorSearcher,
  VectorSearchOptions,
  VectorSearchOutcome,
} from '../vector-index/shared'
import { STORE_ORDINAL_LAYOUT_GENERATION } from '../vector-store/handles'
import type { SharedVectorStoreView } from '../vector-store/view'
import { readStoreFlags } from './store-flags'
import type { SharedVectorFieldView } from './view'

export interface SharedVectorSearcherOptions {
  /** This names the vector field the view belongs to. */
  fieldName: string
  /** This is the thread's open view over the field. */
  view: SharedVectorFieldView
  /** Reports whether the text copy on this thread still holds a document. */
  holdsDocument: (docId: string) => boolean
}

interface Candidates {
  ordinals: number[]
  docIds: string[]
}

interface ScannedResults {
  results: VectorScoredResult[]
  matched: number
}

interface FieldOutcome extends VectorSearchOutcome {
  resolvedEveryHit: boolean
}

function distancesInTypeScript(
  store: SharedVectorStoreView,
  query: Float32Array,
  metric: VectorMetric,
  ordinals: number[],
  clock: SearchClock,
): Float64Array {
  noteFallback('score')
  const arenaQuery = store.prepareQueryArena(query)
  const queryMagnitude = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  const distances = new Float64Array(ordinals.length).fill(Number.POSITIVE_INFINITY)
  for (let i = 0; i < ordinals.length; i++) {
    clock.tick(query.length)
    if (arenaQuery) {
      distances[i] = store.distanceFromArena(arenaQuery, ordinals[i], metric)
      continue
    }
    const entry = store.entryForOrdinal(ordinals[i])
    if (entry) distances[i] = toDistance(query, entry.vector, queryMagnitude, entry.magnitude, metric)
  }
  return distances
}

function scoreCandidates(
  store: SharedVectorStoreView,
  candidates: Candidates,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  clock: SearchClock,
): ScannedResults {
  const { ordinals, docIds } = candidates
  if (ordinals.length === 0) return { results: [], matched: 0 }
  clock.check()
  const distances =
    nativeScoresOf(store.handles, query, metric, ordinals) ??
    distancesInTypeScript(store, query, metric, ordinals, clock)
  clock.check()
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, k)
  let matched = 0
  for (let i = 0; i < ordinals.length; i++) {
    if (distances[i] === Number.POSITIVE_INFINITY) continue
    const score = toScore(distances[i], metric)
    if (score < minSimilarity) continue
    matched++
    heap.push({ docId: docIds[i], score })
  }
  return { results: heap.toSortedArray().reverse(), matched }
}

export function createSharedVectorSearcher(options: SharedVectorSearcherOptions): VectorSearcher {
  const { fieldName, view, holdsDocument } = options
  const flags = readStoreFlags(view.store)

  function ordinalLayoutGeneration(): number {
    return Atomics.load(view.store.handles.header, STORE_ORDINAL_LAYOUT_GENERATION)
  }

  function ordinalSpace(): OrdinalSpace {
    const store = view.store
    const layoutGeneration = ordinalLayoutGeneration()
    return {
      fieldName,
      layoutGeneration,
      slots: store.slots,
      header: store.handles.header,
      ordinalOf: docId => view.ordinalOf(docId),
      holdsCurrentOrdinal: ordinal => store.holdsOrdinal(ordinal) && store.partitionAt(ordinal) !== undefined,
      isRemoved: ordinal => flags.isRemoved(ordinal),
    }
  }

  function filterForPartitions(allowed: ReadonlySet<number>): OrdinalFilter {
    const slots = view.store.slots
    const filter = createOrdinalFilter(slots)
    for (let ordinal = 0; ordinal < slots; ordinal++) {
      const partition = view.store.partitionAt(ordinal)
      if (partition === undefined || !allowed.has(partition)) continue
      if (!view.store.holdsOrdinal(ordinal) || flags.isRemoved(ordinal)) continue
      addToOrdinalFilter(filter, ordinal)
    }
    return filter
  }

  function filterFor(searchOptions: VectorSearchOptions): OrdinalFilter | undefined {
    if (searchOptions.filterSubsets !== undefined) {
      return ordinalFilterForSubsets(searchOptions.filterSubsets, ordinalSpace())
    }
    if (searchOptions.filterPartitions !== undefined) return filterForPartitions(searchOptions.filterPartitions)
    return undefined
  }

  function candidatesOf(ordinals: Iterable<number>, filter: OrdinalFilter | undefined): Candidates {
    const candidates: Candidates = { ordinals: [], docIds: [] }
    for (const ordinal of ordinals) {
      if (filter !== undefined && !ordinalFilterHas(filter, ordinal)) continue
      if (flags.isRemoved(ordinal)) continue
      const docId = view.docIdOf(ordinal)
      if (docId === undefined || view.ordinalOf(docId) !== ordinal) continue
      candidates.ordinals.push(ordinal)
      candidates.docIds.push(docId)
    }
    return candidates
  }

  function answerOf(outcome: FieldOutcome): VectorSearchOutcome {
    const results = outcome.results.filter(result => holdsDocument(result.docId))
    const holdsEveryHit = outcome.resolvedEveryHit && results.length === outcome.results.length
    return { results, matched: outcome.matched, matchedExact: outcome.matchedExact && holdsEveryHit }
  }

  function scanned(scan: ScannedResults): FieldOutcome {
    return { results: scan.results, matched: scan.matched, matchedExact: true, resolvedEveryHit: true }
  }

  function search(
    query: Float32Array,
    k: number,
    searchOptions: VectorSearchOptions,
    filter: OrdinalFilter | undefined,
  ): FieldOutcome {
    const { metric, minSimilarity, efSearch, oversample, rescoreWindow } = searchOptions
    const clock = searchOptions.clock ?? STEADY_CLOCK
    const empty: FieldOutcome = { results: [], matched: 0, matchedExact: true, resolvedEveryHit: true }
    const liveDocuments = flags.liveDocuments()
    if (liveDocuments <= 0) return empty
    if (filter !== undefined && filter.count === 0) return empty

    function fetched(results: VectorScoredResult[], resolvedEveryHit: boolean): FieldOutcome {
      if (minSimilarity === Number.NEGATIVE_INFINITY) {
        const matched = filter === undefined ? liveDocuments : filter.count
        return { results, matched, matchedExact: true, resolvedEveryHit }
      }
      return { results, matched: results.length, matchedExact: false, resolvedEveryHit }
    }

    if (k <= 0) return fetched([], true)
    const graph = view.graph
    if (graph === null) {
      const ordinals = filter === undefined ? flags.unplacedOrdinals() : ordinalFilterValues(filter)
      return scanned(
        scoreCandidates(view.store, candidatesOf(ordinals, filter), query, k, metric, minSimilarity, clock),
      )
    }
    if (filter !== undefined) {
      const graphLiveSize = view.liveSize
      const selectivity = graphLiveSize > 0 ? filter.count / graphLiveSize : 1
      if (selectivity < view.handles.filterThreshold) {
        const candidates = candidatesOf(ordinalFilterValues(filter), filter)
        return scanned(scoreCandidates(view.store, candidates, query, k, metric, minSimilarity, clock))
      }
    }

    let resolvedEveryHit = true
    const graphResults: VectorScoredResult[] = []
    for (const hit of view.searchOrdinals(query, k, metric, minSimilarity, {
      filter,
      efSearch,
      oversample,
      rescoreWindow,
      clock,
    })) {
      const docId = view.docIdOf(hit.ord)
      if (docId === undefined) {
        resolvedEveryHit = false
        continue
      }
      graphResults.push({ docId, score: hit.score })
    }
    const unplaced = flags.unplacedOrdinals()
    if (unplaced.length === 0) return fetched(graphResults, resolvedEveryHit)
    const scan = scoreCandidates(view.store, candidatesOf(unplaced, filter), query, k, metric, minSimilarity, clock)
    return fetched(mergeResults(graphResults, scan.results, k), resolvedEveryHit)
  }

  return {
    fieldName,
    dimension: view.handles.dimension,
    partitionsKnown: () => true,
    assignPartitions: () => undefined,
    searchParallel(query, k, searchOptions) {
      if (query.length !== view.handles.dimension) {
        throw new NarsilError(
          ErrorCodes.VECTOR_DIMENSION_MISMATCH,
          `Vector dimension mismatch: expected ${view.handles.dimension}, got ${query.length}`,
          { expected: view.handles.dimension, received: query.length },
        )
      }
      for (let attempt = 1; ; attempt++) {
        const layoutGeneration = ordinalLayoutGeneration()
        const outcome = search(query, k, searchOptions, filterFor(searchOptions))
        if (view.graphRetired) {
          throw new NarsilError(
            ErrorCodes.WORKER_BUSY,
            `The main thread replaced the graph of vector field "${fieldName}" while this thread searched it`,
            { fieldName },
          )
        }
        if (ordinalLayoutGeneration() === layoutGeneration) return Promise.resolve(answerOf(outcome))
        if (attempt >= MAX_RENUMBERED_SEARCH_ATTEMPTS) {
          throw new NarsilError(
            ErrorCodes.WORKER_BUSY,
            `The main thread renumbered the vectors of field "${fieldName}" during each of ${attempt} searches on this thread`,
            { fieldName, attempts: attempt },
          )
        }
      }
    },
  }
}
