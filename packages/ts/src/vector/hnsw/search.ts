import { compareCodePoints } from '../../core/ordering'
import type { ScoredDocument } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { magnitude } from '../similarity'
import type { ArenaQueryVector } from '../vector-store'
import { nearestFromHeap, searchLayer } from './graph-ops'
import {
  type DistancePair,
  entryForOrd,
  type HNSWGraphState,
  type HNSWSearchState,
  SQ8_OVERSELECTION_FACTOR,
  toDistance,
  toScore,
} from './shared'

/**
 * The rank value marking an ordinal that holds no document, so a worker can
 * tell a live ordinal from a recycled one without holding any strings.
 *
 * @internal
 */
export const ABSENT_DOCUMENT_RANK = 0xffffffff

/**
 * One search result before its ordinal is mapped back to a document id.
 *
 * @internal
 */
export interface OrdinalHit {
  /** The store ordinal the hit refers to. */
  ord: number
  /** The similarity score under the search metric. */
  score: number
}

function collectHits(
  state: HNSWSearchState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
  efSearch: number | undefined,
  hasDocument: (ord: number) => boolean,
): OrdinalHit[] {
  if (query.length !== state.dimension) {
    throw new Error(`Query dimension mismatch: expected ${state.dimension}, got ${query.length}`)
  }

  const liveSize = state.nodeCount - state.tombstoneCount
  if (state.entryPointOrd === -1 || liveSize === 0) {
    return []
  }

  const useQuantized = state.quantizer?.isCalibrated() === true && state.quantizer.size > 0
  const defaultEf = 50
  let ef = Math.max(efSearch ?? defaultEf, k)

  if (filter && filter.count < liveSize) {
    const selectivity = filter.count / liveSize
    ef = Math.max(ef, Math.ceil(k / Math.max(selectivity, 0.01)))
    ef = Math.min(ef, liveSize)
  }

  const store = state.store
  const arenaQuery = store.prepareQueryArena(query)
  const qMag = arenaQuery ? arenaQuery.magnitude : magnitude(query)

  let quantizedDistFn: ((ord: number) => number) | undefined
  if (useQuantized && state.quantizer) {
    const q = state.quantizer
    const metric = searchMetric
    const quantizedArenaQuery = q.prepareQueryArena(query)
    if (quantizedArenaQuery) {
      quantizedDistFn = (ord: number) => q.distanceFromArena(quantizedArenaQuery, ord, metric)
    } else {
      const prepared = q.prepareQuery(query)
      if (prepared) {
        quantizedDistFn = (ord: number) => q.distanceFromPreparedByOrdinal(prepared, ord, metric)
      }
    }
  }

  let distFn = quantizedDistFn
  if (!distFn && arenaQuery) {
    const metric = searchMetric
    distFn = (ord: number) => store.distanceFromArena(arenaQuery, ord, metric)
  }

  let currentEPs = [state.entryPointOrd]

  for (let layer = state.topLayer; layer >= 1; layer--) {
    const heap = searchLayer(state, query, qMag, currentEPs, 1, layer, searchMetric, true, distFn)
    const nearest = nearestFromHeap(heap)
    if (nearest) {
      currentEPs = [nearest.ord]
    }
  }

  const candidateHeap = searchLayer(state, query, qMag, currentEPs, ef, 0, searchMetric, true, distFn)
  const candidateArray = candidateHeap.toSortedArray().reverse()

  if (useQuantized) {
    return rerankWithFullPrecision(
      state,
      candidateArray,
      query,
      qMag,
      arenaQuery,
      k,
      searchMetric,
      minSimilarity,
      filter,
      hasDocument,
    )
  }

  const hits: OrdinalHit[] = []
  for (const cand of candidateArray) {
    if (filter && !ordinalFilterHas(filter, cand.ord)) continue
    const score = toScore(cand.distance, searchMetric)
    if (score < minSimilarity) continue
    if (!hasDocument(cand.ord)) continue
    hits.push({ ord: cand.ord, score })
  }
  return hits
}

function rerankWithFullPrecision(
  state: HNSWSearchState,
  candidates: DistancePair[],
  query: Float32Array,
  qMag: number,
  arenaQuery: ArenaQueryVector | null,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
  hasDocument: (ord: number) => boolean,
): OrdinalHit[] {
  const reranked: OrdinalHit[] = []
  const rerankLimit = Math.max(k * SQ8_OVERSELECTION_FACTOR, 10)

  for (const cand of candidates) {
    if (filter && !ordinalFilterHas(filter, cand.ord)) continue

    let fullDistance: number
    if (arenaQuery) {
      fullDistance = state.store.distanceFromArena(arenaQuery, cand.ord, metric)
      if (fullDistance === Number.POSITIVE_INFINITY) continue
    } else {
      const entry = entryForOrd(state, cand.ord)
      if (!entry) continue
      fullDistance = toDistance(query, entry.vector, qMag, entry.magnitude, metric)
    }

    const score = toScore(fullDistance, metric)
    if (score < minSimilarity) continue
    if (!hasDocument(cand.ord)) continue

    reranked.push({ ord: cand.ord, score })

    if (reranked.length >= rerankLimit) break
  }

  return reranked
}

/**
 * Searches the graph and returns scored documents, best first, tying on
 * document id in code point order.
 *
 * @internal
 */
export function search(
  state: HNSWGraphState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  filter?: OrdinalFilter,
  efSearch?: number,
): ScoredDocument[] {
  const hasDocument = (ord: number) => state.store.docIdForOrdinal(ord) !== undefined
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, filter, efSearch, hasDocument)

  const results: ScoredDocument[] = []
  for (const hit of hits) {
    const docId = state.store.docIdForOrdinal(hit.ord)
    if (docId === undefined) continue
    results.push({
      docId,
      score: hit.score,
      termFrequencies: {},
      fieldLengths: {},
      idf: {},
    })
  }

  results.sort((a, b) => b.score - a.score || compareCodePoints(a.docId, b.docId))
  return results.slice(0, k)
}

/**
 * Searches the graph and returns ordinal hits, best first, tying on the
 * supplied rank table.
 *
 * A worker searching a shared copy holds no document id strings, so it ties
 * on each ordinal's precomputed code point rank instead, which reproduces the
 * exact order {@link search} produces, and the calling thread maps the
 * ordinals back to ids.
 *
 * @param state The search state over the shared copy.
 * @param query The query vector.
 * @param k The maximum number of hits to return.
 * @param searchMetric The distance metric to rank by.
 * @param minSimilarity The score below which a hit is dropped.
 * @param rankByOrdinal Each ordinal's document id rank in code point order,
 * or {@link ABSENT_DOCUMENT_RANK} where the ordinal holds no document.
 * @param filter The ordinals allowed in the result, or every ordinal when
 * absent.
 * @param efSearch The exploration factor, defaulting as {@link search} does.
 * @returns Ordinal hits, best first.
 *
 * @internal
 */
export function searchOrdinals(
  state: HNSWSearchState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  rankByOrdinal: Uint32Array,
  filter?: OrdinalFilter,
  efSearch?: number,
): OrdinalHit[] {
  const hasDocument = (ord: number) => ord < rankByOrdinal.length && rankByOrdinal[ord] !== ABSENT_DOCUMENT_RANK
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, filter, efSearch, hasDocument)
  hits.sort((a, b) => b.score - a.score || rankByOrdinal[a.ord] - rankByOrdinal[b.ord])
  return hits.slice(0, k)
}
