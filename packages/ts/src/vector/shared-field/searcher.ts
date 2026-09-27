import { createBoundedMaxHeap } from '../../core/heap'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import type { OrdinalHit } from '../hnsw/search'
import { entryForOrd, type HNSWSearchState, isTombstoned, toDistance, toScore } from '../hnsw/shared'
import { noteFallback } from '../native/backend'
import { nativeScoresOf } from '../native/store'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter, ordinalFilterValues } from '../ordinal-filter'
import { magnitude } from '../similarity'
import type { VectorScoredResult, VectorSearcher, VectorSearchOptions } from '../vector-index/shared'
import type { SharedVectorFieldView } from './view'

export interface SharedVectorSearcherOptions {
  /** This names the vector field the view belongs to. */
  fieldName: string
  /** This is the thread's open view over the field. */
  view: SharedVectorFieldView
  /** Reports whether the text copy on this thread still holds a document. */
  holdsDocument: (docId: string) => boolean
}

type ResolvedHit = OrdinalHit & { docId: string }

interface ScannedHits {
  hits: OrdinalHit[]
  matched: number
  matchedExact: boolean
}

function bestFirst(a: ResolvedHit, b: ResolvedHit): number {
  return b.score - a.score || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0)
}

function distancesInTypeScript(
  state: HNSWSearchState,
  query: Float32Array,
  metric: VectorMetric,
  ordinals: number[],
): Float64Array {
  noteFallback('score')
  const arenaQuery = state.store.prepareQueryArena(query)
  const queryMagnitude = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  const distances = new Float64Array(ordinals.length).fill(Number.POSITIVE_INFINITY)
  for (let i = 0; i < ordinals.length; i++) {
    if (arenaQuery) {
      distances[i] = state.store.distanceFromArena(arenaQuery, ordinals[i], metric)
      continue
    }
    const entry = entryForOrd(state, ordinals[i])
    if (entry) distances[i] = toDistance(query, entry.vector, queryMagnitude, entry.magnitude, metric)
  }
  return distances
}

function bruteForceOrdinals(
  state: HNSWSearchState,
  docIdOf: (ord: number) => string | undefined,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter,
): ScannedHits {
  const ordinals: number[] = []
  const docIds: string[] = []
  for (const ord of ordinalFilterValues(filter)) {
    if (isTombstoned(state, ord)) continue
    const docId = docIdOf(ord)
    if (docId === undefined) continue
    ordinals.push(ord)
    docIds.push(docId)
  }
  const distances =
    nativeScoresOf(state.store.handles, query, metric, ordinals) ??
    distancesInTypeScript(state, query, metric, ordinals)
  const heap = createBoundedMaxHeap<ResolvedHit>(bestFirst, k)
  let matched = 0
  for (let i = 0; i < ordinals.length; i++) {
    if (distances[i] === Number.POSITIVE_INFINITY) continue
    const score = toScore(distances[i], metric)
    if (score < minSimilarity) continue
    matched++
    heap.push({ ord: ordinals[i], score, docId: docIds[i] })
  }
  return { hits: heap.toSortedArray().reverse(), matched, matchedExact: true }
}

export function createSharedVectorSearcher(options: SharedVectorSearcherOptions): VectorSearcher {
  const { fieldName, view, holdsDocument } = options

  function filterForDocIds(allowed: Set<string>): OrdinalFilter {
    const filter = createOrdinalFilter(view.store.slots)
    const graph = view.graph
    for (const docId of allowed) {
      const ordinal = view.ordinalOf(docId)
      if (ordinal === undefined) continue
      if (graph !== null && isTombstoned(graph, ordinal)) continue
      addToOrdinalFilter(filter, ordinal)
    }
    return filter
  }

  function filterForPartitions(allowed: ReadonlySet<number>): OrdinalFilter {
    const slots = view.store.slots
    const filter = createOrdinalFilter(slots)
    for (let ordinal = 0; ordinal < slots; ordinal++) {
      const partition = view.store.partitionAt(ordinal)
      if (partition !== undefined && allowed.has(partition) && view.store.holdsOrdinal(ordinal)) {
        addToOrdinalFilter(filter, ordinal)
      }
    }
    return filter
  }

  function filterFor(searchOptions: VectorSearchOptions): OrdinalFilter | undefined {
    if (searchOptions.filterDocIds !== undefined) return filterForDocIds(searchOptions.filterDocIds)
    if (searchOptions.filterPartitions !== undefined) return filterForPartitions(searchOptions.filterPartitions)
    return undefined
  }

  function hitsFor(
    query: Float32Array,
    k: number,
    searchOptions: VectorSearchOptions,
    filter?: OrdinalFilter,
  ): ScannedHits {
    const { metric, minSimilarity, efSearch, oversample } = searchOptions
    const liveSize = view.liveSize
    const graph = view.graph
    if (
      graph !== null &&
      filter !== undefined &&
      liveSize > 0 &&
      filter.count / liveSize < view.handles.filterThreshold
    ) {
      return bruteForceOrdinals(graph, view.docIdOf, query, k, metric, minSimilarity, filter)
    }
    const hits = view.searchOrdinals(query, k, metric, minSimilarity, { filter, efSearch, oversample })
    if (minSimilarity === Number.NEGATIVE_INFINITY) {
      return { hits, matched: filter === undefined ? liveSize : filter.count, matchedExact: true }
    }
    return { hits, matched: hits.length, matchedExact: false }
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
      const filter = filterFor(searchOptions)
      if (filter !== undefined && filter.count === 0) {
        return Promise.resolve({ results: [], matched: 0, matchedExact: true })
      }
      const scanned = hitsFor(query, k, searchOptions, filter)
      const results: VectorScoredResult[] = []
      for (const hit of scanned.hits) {
        const docId = view.docIdOf(hit.ord)
        if (docId === undefined || !holdsDocument(docId)) continue
        results.push({ docId, score: hit.score })
      }
      const holdsEveryHit = results.length === scanned.hits.length
      return Promise.resolve({
        results,
        matched: scanned.matched,
        matchedExact: scanned.matchedExact && holdsEveryHit,
      })
    },
  }
}
