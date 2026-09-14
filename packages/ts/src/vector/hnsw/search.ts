import { compareCodePoints } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import type { ScoredDocument } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { DEFAULT_OVERSAMPLE_BY_BITS } from '../osq/constants'
import { magnitude } from '../similarity'
import type { ArenaQueryVector } from '../vector-store'
import { DEFAULT_EF_SEARCH } from './constants'
import { searchLayer } from './graph-ops'
import { lockGraphShared, unlockGraphShared } from './locks'
import {
  activeQuantizer,
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

export interface OrdinalHit {
  /** The hit refers to this store ordinal. */
  ord: number
  /** This is the hit's similarity score under the search metric. */
  score: number
}

export interface GraphSearchOptions {
  filter?: OrdinalFilter
  efSearch?: number
  oversample?: number
}

interface Traversal {
  candidates: DistanceList
  depth: number
  arenaQuery: ArenaQueryVector | null
  qMag: number
}

function traverse(
  state: HNSWSearchState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  options: GraphSearchOptions,
): Traversal {
  const liveSize = nodeCountOf(state) - tombstoneCountOf(state)
  const calibrated = activeQuantizer(state)
  const quantizer = calibrated === undefined || calibrated.size === 0 ? undefined : calibrated
  const useQuantized = quantizer !== undefined
  const depth =
    quantizer === undefined ? k : Math.ceil(k * (options.oversample ?? DEFAULT_OVERSAMPLE_BY_BITS[quantizer.bits]))
  let ef = Math.max(options.efSearch ?? DEFAULT_EF_SEARCH, depth)

  const filter = options.filter
  if (filter && filter.count < liveSize) {
    const selectivity = filter.count / liveSize
    ef = Math.max(ef, Math.ceil(k / Math.max(selectivity, 0.01)))
    ef = Math.min(ef, liveSize)
  }

  const store = state.store
  const arenaQuery = store.prepareQueryArena(query)
  const qMag = arenaQuery ? arenaQuery.magnitude : magnitude(query)

  let distFn: ((ord: number) => number) | undefined
  if (quantizer !== undefined) {
    const prepared = quantizer.prepareQuery(query)
    if (prepared) distFn = (ord: number) => quantizer.distanceFromPreparedByOrdinal(prepared, ord)
  }
  if (!distFn && arenaQuery) {
    distFn = (ord: number) => store.distanceFromArena(arenaQuery, ord, searchMetric)
  }

  const workspace = state.workspace
  const candidates = workspace.traversal
  candidates.size = 0
  lockGraphShared(state.locks)
  try {
    const entryPoint = entryPointOf(state)
    if (entryPoint === -1) return { candidates, depth: useQuantized ? depth : 0, arenaQuery, qMag }
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
  return { candidates, depth: useQuantized ? depth : 0, arenaQuery, qMag }
}

function collectHits(
  state: HNSWSearchState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  options: GraphSearchOptions,
  hasDocument: (ord: number) => boolean,
): OrdinalHit[] {
  if (query.length !== state.dimension) {
    throw new NarsilError(
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      `Vector dimension mismatch: expected ${state.dimension}, got ${query.length}`,
      { expected: state.dimension, received: query.length },
    )
  }

  const liveSize = nodeCountOf(state) - tombstoneCountOf(state)
  if (entryPointOf(state) === -1 || liveSize === 0) {
    return []
  }

  const { candidates, depth, arenaQuery, qMag } = traverse(state, query, k, searchMetric, options)

  if (depth > 0) {
    return rescoreWithFullPrecision(
      state,
      candidates,
      query,
      qMag,
      arenaQuery,
      depth,
      searchMetric,
      minSimilarity,
      options.filter,
      hasDocument,
    )
  }

  const hits: OrdinalHit[] = []
  const filter = options.filter
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

function rescoreWithFullPrecision(
  state: HNSWSearchState,
  candidates: DistanceList,
  query: Float32Array,
  qMag: number,
  arenaQuery: ArenaQueryVector | null,
  depth: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
  hasDocument: (ord: number) => boolean,
): OrdinalHit[] {
  const rescored: OrdinalHit[] = []
  const nearest = Math.min(candidates.size, depth)

  for (let i = 0; i < nearest; i++) {
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

    rescored.push({ ord, score })
  }

  return rescored
}

export function search(
  state: HNSWSearchState,
  docIdOf: (ord: number) => string | undefined,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  options: GraphSearchOptions = {},
): ScoredDocument[] {
  const hasDocument = (ord: number) => docIdOf(ord) !== undefined
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, options, hasDocument)

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

export function searchOrdinals(
  state: HNSWSearchState,
  docIdOf: (ord: number) => string | undefined,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  options: GraphSearchOptions = {},
): OrdinalHit[] {
  const ids = new Map<number, string>()
  const hasDocument = (ord: number): boolean => {
    const docId = docIdOf(ord)
    if (docId === undefined) return false
    ids.set(ord, docId)
    return true
  }
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, options, hasDocument)
  hits.sort((a, b) => b.score - a.score || compareCodePoints(ids.get(a.ord) ?? '', ids.get(b.ord) ?? ''))
  return hits.slice(0, k)
}
