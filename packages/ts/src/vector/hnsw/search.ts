import { compareCodePoints } from '../../core/ordering'
import type { ScoredDocument } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { magnitude } from '../similarity'
import type { ArenaQueryVector } from '../vector-store'
import { SQ8_OVERSELECTION_FACTOR, SQ8_RERANK_FLOOR } from './constants'
import { searchLayer } from './graph-ops'
import { lockGraphShared, unlockGraphShared } from './locks'
import {
  entryForOrd,
  entryPointOf,
  type HNSWSearchState,
  nodeCountOf,
  toDistance,
  tombstoneCountOf,
  topLayerOf,
  toScore,
} from './shared'
import { type DistanceList, setSingleEntryPoint } from './workspace'

/**
 * This is one search result, holding the ordinal the caller maps back to a
 * document id itself.
 *
 * @internal
 */
export interface OrdinalHit {
  /** The hit refers to this store ordinal. */
  ord: number
  /** This is the hit's similarity score under the search metric. */
  score: number
}

function traverse(
  state: HNSWSearchState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  filter: OrdinalFilter | undefined,
  efSearch: number | undefined,
): { candidates: DistanceList; useQuantized: boolean; arenaQuery: ArenaQueryVector | null; qMag: number } {
  const liveSize = nodeCountOf(state) - tombstoneCountOf(state)
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

  const workspace = state.workspace
  const candidates = workspace.traversal
  candidates.size = 0
  lockGraphShared(state.locks)
  try {
    const entryPoint = entryPointOf(state)
    if (entryPoint === -1) return { candidates, useQuantized, arenaQuery, qMag }
    setSingleEntryPoint(workspace, entryPoint)

    for (let layer = topLayerOf(state); layer >= 1; layer--) {
      searchLayer(state, query, qMag, 1, layer, searchMetric, true, distFn, candidates)
      if (candidates.size > 0) {
        setSingleEntryPoint(workspace, candidates.ords[0])
      }
    }

    searchLayer(state, query, qMag, ef, 0, searchMetric, true, distFn, candidates)
  } finally {
    unlockGraphShared(state.locks)
  }
  return { candidates, useQuantized, arenaQuery, qMag }
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

  const liveSize = nodeCountOf(state) - tombstoneCountOf(state)
  if (entryPointOf(state) === -1 || liveSize === 0) {
    return []
  }

  const { candidates, useQuantized, arenaQuery, qMag } = traverse(state, query, k, searchMetric, filter, efSearch)

  if (useQuantized) {
    return rerankWithFullPrecision(
      state,
      candidates,
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
  for (let i = 0; i < candidates.size; i++) {
    const ord = candidates.ords[i]
    if (filter && !ordinalFilterHas(filter, ord)) continue
    const score = toScore(candidates.distances[i], searchMetric)
    if (score < minSimilarity) continue
    if (!hasDocument(ord)) continue
    hits.push({ ord, score })
  }
  return hits
}

function rerankWithFullPrecision(
  state: HNSWSearchState,
  candidates: DistanceList,
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
  const rerankLimit = Math.max(k * SQ8_OVERSELECTION_FACTOR, SQ8_RERANK_FLOOR)

  for (let i = 0; i < candidates.size; i++) {
    const ord = candidates.ords[i]
    if (filter && !ordinalFilterHas(filter, ord)) continue

    let fullDistance: number
    if (arenaQuery) {
      fullDistance = state.store.distanceFromArena(arenaQuery, ord, metric)
      if (fullDistance === Number.POSITIVE_INFINITY) continue
    } else {
      const entry = entryForOrd(state, ord)
      if (!entry) continue
      fullDistance = toDistance(query, entry.vector, qMag, entry.magnitude, metric)
    }

    const score = toScore(fullDistance, metric)
    if (score < minSimilarity) continue
    if (!hasDocument(ord)) continue

    reranked.push({ ord, score })

    if (reranked.length >= rerankLimit) break
  }

  return reranked
}

/**
 * Searches the graph and returns scored documents, best first, tying on
 * document id in code point order.
 *
 * @param state The graph to search.
 * @param docIdOf Reports the document id at an ordinal, or undefined where
 * the ordinal holds no live document.
 * @param query The query vector.
 * @param k The maximum number of hits to return.
 * @param searchMetric The distance metric to rank by.
 * @param minSimilarity The score below which a hit is dropped.
 * @param filter The ordinals allowed in the result, or every ordinal when
 * absent.
 * @param efSearch The exploration factor, defaulting to 50.
 * @returns Scored documents, best first.
 *
 * @internal
 */
export function search(
  state: HNSWSearchState,
  docIdOf: (ord: number) => string | undefined,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  filter?: OrdinalFilter,
  efSearch?: number,
): ScoredDocument[] {
  const hasDocument = (ord: number) => docIdOf(ord) !== undefined
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, filter, efSearch, hasDocument)

  const results: ScoredDocument[] = []
  for (const hit of hits) {
    const docId = docIdOf(hit.ord)
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
 * Searches the graph and returns ordinal hits, best first, tying on document
 * id in code point order, for a caller that maps ordinals back to ids itself.
 *
 * @param state The graph to search.
 * @param docIdOf Reports the document id at an ordinal, or undefined where
 * the ordinal holds no live document.
 * @param query The query vector.
 * @param k The maximum number of hits to return.
 * @param searchMetric The distance metric to rank by.
 * @param minSimilarity The score below which a hit is dropped.
 * @param filter The ordinals allowed in the result, or every ordinal when
 * absent.
 * @param efSearch The exploration factor, defaulting as {@link search} does.
 * @returns Ordinal hits, best first.
 *
 * @internal
 */
export function searchOrdinals(
  state: HNSWSearchState,
  docIdOf: (ord: number) => string | undefined,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  filter?: OrdinalFilter,
  efSearch?: number,
): OrdinalHit[] {
  const ids = new Map<number, string>()
  const hasDocument = (ord: number): boolean => {
    const docId = docIdOf(ord)
    if (docId === undefined) return false
    ids.set(ord, docId)
    return true
  }
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, filter, efSearch, hasDocument)
  hits.sort((a, b) => b.score - a.score || compareCodePoints(ids.get(a.ord) ?? '', ids.get(b.ord) ?? ''))
  return hits.slice(0, k)
}
