import { createBoundedMaxHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import { type OrdinalHit, searchOrdinals } from '../hnsw/search'
import { entryForOrd, type HNSWSearchState, toDistance, toScore } from '../hnsw/shared'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter, ordinalFilterValues } from '../ordinal-filter'
import { magnitude } from '../similarity'
import { DEFAULT_FILTER_THRESHOLD } from '../vector-index/constants'
import type { VectorScoredResult, VectorSearcher, VectorSearchOptions } from '../vector-index/shared'
import { docIdAt, type SharedDocIdTable } from './doc-ids'
import type { SharedGenerationSnapshot } from './types'
import { openSharedWorkerCopy } from './worker-view'

/**
 * What a request thread needs to answer vector searches from a frozen copy.
 *
 * @internal
 */
export interface SharedVectorSearcherOptions {
  /** The vector field the copy belongs to. */
  fieldName: string
  /** The frozen copy to search. */
  snapshot: SharedGenerationSnapshot
  /** This thread's scratch slot inside the copy. */
  scratchSlot: number
  /** The document id and partition at each ordinal. */
  docIds: SharedDocIdTable
  /** A filter admitting a smaller share of the live vectors than this is answered by exact comparison. */
  filterThreshold?: number
  /** Reports whether the text copy on this thread still holds a document. */
  holdsDocument: (docId: string) => boolean
}

function bruteForceOrdinals(
  state: HNSWSearchState,
  rankByOrdinal: Uint32Array,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter,
): OrdinalHit[] {
  const arenaQuery = state.store.prepareQueryArena(query)
  const queryMagnitude = arenaQuery ? arenaQuery.magnitude : magnitude(query)
  const bestFirst = (a: OrdinalHit, b: OrdinalHit) => b.score - a.score || rankByOrdinal[a.ord] - rankByOrdinal[b.ord]
  const heap = createBoundedMaxHeap<OrdinalHit>(bestFirst, k)
  for (const ord of ordinalFilterValues(filter)) {
    if (ord >= rankByOrdinal.length || state.tombstones[ord] === 1) continue
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
    if (score >= minSimilarity) heap.push({ ord, score })
  }
  return heap.toSortedArray().reverse()
}

function ordinalsByDocId(docIds: SharedDocIdTable): Map<string, number> {
  const ordinals = new Map<string, number>()
  for (let ordinal = 0; ordinal < docIds.partitions.length; ordinal++) {
    const docId = docIdAt(docIds, ordinal)
    if (docId !== undefined) ordinals.set(docId, ordinal)
  }
  return ordinals
}

/**
 * Opens a frozen copy on the current thread as something a query can search,
 * mapping each ordinal hit back to its document id through the shared table.
 *
 * The searcher drops a hit whose document the text copy no longer holds, so
 * a removal that reached the text copy before the next frozen copy arrives
 * never surfaces as a hit with no document.
 *
 * @param options The copy, this thread's scratch slot, and the id table.
 * @returns The searcher a query context resolves the field to.
 *
 * @internal
 */
export function createSharedVectorSearcher(options: SharedVectorSearcherOptions): VectorSearcher {
  const { fieldName, snapshot, scratchSlot, docIds, holdsDocument } = options
  const filterThreshold = options.filterThreshold ?? DEFAULT_FILTER_THRESHOLD
  const copy = openSharedWorkerCopy(snapshot, scratchSlot)
  const slots = docIds.partitions.length
  let ordinalIndex: Map<string, number> | null = null

  function hitsFor(query: Float32Array, k: number, searchOptions: VectorSearchOptions, filter?: OrdinalFilter) {
    const { metric, minSimilarity, efSearch } = searchOptions
    const liveSize = copy.searchState.nodeCount - copy.searchState.tombstoneCount
    if (filter !== undefined && liveSize > 0 && filter.count / liveSize < filterThreshold) {
      return bruteForceOrdinals(copy.searchState, copy.rankByOrdinal, query, k, metric, minSimilarity, filter)
    }
    return searchOrdinals(copy.searchState, query, k, metric, minSimilarity, copy.rankByOrdinal, filter, efSearch)
  }

  function filterForDocIds(allowed: Set<string>): OrdinalFilter {
    if (ordinalIndex === null) ordinalIndex = ordinalsByDocId(docIds)
    const filter = createOrdinalFilter(slots)
    for (const docId of allowed) {
      const ordinal = ordinalIndex.get(docId)
      if (ordinal !== undefined) addToOrdinalFilter(filter, ordinal)
    }
    return filter
  }

  function filterForPartitions(allowed: ReadonlySet<number>): OrdinalFilter {
    const filter = createOrdinalFilter(slots)
    for (let ordinal = 0; ordinal < slots; ordinal++) {
      if (allowed.has(docIds.partitions[ordinal])) addToOrdinalFilter(filter, ordinal)
    }
    return filter
  }

  function filterFor(searchOptions: VectorSearchOptions): OrdinalFilter | undefined {
    if (searchOptions.filterDocIds !== undefined) return filterForDocIds(searchOptions.filterDocIds)
    if (searchOptions.filterPartitions !== undefined) return filterForPartitions(searchOptions.filterPartitions)
    return undefined
  }

  return {
    fieldName,
    dimension: snapshot.dimension,
    partitionsKnown: () => true,
    assignPartitions: () => undefined,
    searchParallel(query, k, searchOptions) {
      const filter = filterFor(searchOptions)
      if (filter !== undefined && filter.count === 0) return Promise.resolve([])
      const hits = hitsFor(query, k, searchOptions, filter)
      const results: VectorScoredResult[] = []
      for (const hit of hits) {
        const docId = docIdAt(docIds, hit.ord)
        if (docId === undefined || !holdsDocument(docId)) continue
        results.push({ docId, score: hit.score })
      }
      return Promise.resolve(results)
    },
  }
}
