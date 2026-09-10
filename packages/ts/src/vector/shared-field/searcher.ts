import { createBoundedMaxHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import type { OrdinalHit } from '../hnsw/search'
import { entryForOrd, type HNSWSearchState, isTombstoned, toDistance, toScore } from '../hnsw/shared'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter, ordinalFilterValues } from '../ordinal-filter'
import { magnitude } from '../similarity'
import type { VectorScoredResult, VectorSearcher, VectorSearchOptions } from '../vector-index/shared'
import type { SharedVectorFieldView } from './view'

/**
 * A request thread needs these to answer vector searches from a field it
 * holds in place.
 *
 * @internal
 */
export interface SharedVectorSearcherOptions {
  /** This names the vector field the view belongs to. */
  fieldName: string
  /** This is the thread's open view over the field. */
  view: SharedVectorFieldView
  /** Reports whether the text copy on this thread still holds a document. */
  holdsDocument: (docId: string) => boolean
}

function bruteForceOrdinals(
  state: HNSWSearchState,
  docIdOf: (ord: number) => string | undefined,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter,
): Array<OrdinalHit & { docId: string }> {
  const arenaQuery = state.store.prepareQueryArena(query)
  const queryMagnitude = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  const bestFirst = (a: OrdinalHit & { docId: string }, b: OrdinalHit & { docId: string }) =>
    b.score - a.score || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0)
  const heap = createBoundedMaxHeap<OrdinalHit & { docId: string }>(bestFirst, k)
  for (const ord of ordinalFilterValues(filter)) {
    if (isTombstoned(state, ord)) continue
    const docId = docIdOf(ord)
    if (docId === undefined) continue
    let distance: number
    if (arenaQuery) {
      distance = state.store.distanceFromArena(arenaQuery, ord, metric)
      if (distance === Number.POSITIVE_INFINITY) continue
    } else {
      const entry = entryForOrd(state, ord)
      if (!entry) continue
      distance = toDistance(query, entry.vector, queryMagnitude, entry.magnitude, metric)
    }
    const score = toScore(distance, metric)
    if (score >= minSimilarity) heap.push({ ord, score, docId })
  }
  return heap.toSortedArray().reverse()
}

/**
 * Opens a field on the current thread as something a query can search,
 * mapping each ordinal hit back to its document id through the shared table.
 *
 * The searcher drops a hit whose document the text copy has released, so
 * every hit it returns names a document that copy still holds, even where a
 * removal reached the text copy before the vector index compacted it.
 *
 * @param options The view, the field name, and the text copy check.
 * @returns The searcher a query context resolves the field to.
 *
 * @internal
 */
export function createSharedVectorSearcher(options: SharedVectorSearcherOptions): VectorSearcher {
  const { fieldName, view, holdsDocument } = options

  function filterForDocIds(allowed: Set<string>): OrdinalFilter {
    const filter = createOrdinalFilter(view.store.slots)
    for (const docId of allowed) {
      const ordinal = view.ordinalOf(docId)
      if (ordinal !== undefined) addToOrdinalFilter(filter, ordinal)
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

  function hitsFor(query: Float32Array, k: number, searchOptions: VectorSearchOptions, filter?: OrdinalFilter) {
    const { metric, minSimilarity, efSearch } = searchOptions
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
    return view.searchOrdinals(query, k, metric, minSimilarity, filter, efSearch)
  }

  return {
    fieldName,
    dimension: view.handles.dimension,
    partitionsKnown: () => true,
    assignPartitions: () => undefined,
    searchParallel(query, k, searchOptions) {
      const filter = filterFor(searchOptions)
      if (filter !== undefined && filter.count === 0) return Promise.resolve([])
      const hits = hitsFor(query, k, searchOptions, filter)
      const results: VectorScoredResult[] = []
      for (const hit of hits) {
        const docId = view.docIdOf(hit.ord)
        if (docId === undefined || !holdsDocument(docId)) continue
        results.push({ docId, score: hit.score })
      }
      return Promise.resolve(results)
    },
  }
}
