import { compareCodePoints } from '../../core/ordering'
import type { SearchClock } from '../../core/search-clock'
import { ErrorCodes, NarsilError } from '../../errors'
import type { ScoredDocument } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import { noteFallback } from '../native/backend'
import { type NativeField, nativeFieldFor } from '../native/field'
import { nativeRescoredHits, nativeTraverse } from '../native/walk'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { defaultEfSearch, defaultRescoreDepth } from '../search-depth'
import { magnitude } from '../similarity'
import type { ArenaQueryVector } from '../vector-store'
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
  rescoreWindow?: number
  clock?: SearchClock
}

interface Traversal {
  candidates: DistanceList
  depth: number
  arenaQuery: ArenaQueryVector | null
  qMag: number
  native: NativeField | null
}

function traverse(
  state: HNSWSearchState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  options: GraphSearchOptions,
): Traversal {
  const calibrated = activeQuantizer(state)
  const quantizer = calibrated === undefined || calibrated.size === 0 ? undefined : calibrated
  const useQuantized = quantizer !== undefined
  const window = options.rescoreWindow ?? k
  let depth = window
  if (quantizer !== undefined) {
    depth =
      options.oversample === undefined
        ? defaultRescoreDepth(quantizer.bits, state.dimension, window)
        : Math.ceil(window * options.oversample)
  }
  const ef = Math.max(options.efSearch ?? defaultEfSearch(state.dimension, window), depth)
  const filter = options.filter

  const workspace = state.workspace
  const candidates = workspace.traversal
  const native = nativeFieldFor(state)
  if (native !== null) {
    candidates.size = 0
    if (nativeTraverse(state, native, query, ef, searchMetric, filter, candidates)) {
      return { candidates, depth: useQuantized ? depth : 0, arenaQuery: null, qMag: 0, native }
    }
  }
  noteFallback('search')

  const store = state.store
  const arenaQuery = store.prepareQueryArena(query)
  const qMag = arenaQuery ? arenaQuery.magnitude : magnitude(query)

  let distFn: ((ord: number) => number) | undefined
  if (quantizer !== undefined) {
    const prepared = quantizer.prepareQuery(query)
    if (prepared) distFn = quantizer.preparedDistance(prepared)
  }
  if (!distFn && arenaQuery) {
    distFn = store.queryDistance(arenaQuery, searchMetric)
  }

  candidates.size = 0
  lockGraphShared(state.locks)
  try {
    const entryPoint = entryPointOf(state)
    if (entryPoint === -1) return { candidates, depth: useQuantized ? depth : 0, arenaQuery, qMag, native: null }
    setSingleEntryPoint(workspace, entryPoint)

    for (let layer = topLayerOf(state); layer >= 1; layer--) {
      searchLayer(state, query, qMag, 1, layer, searchMetric, false, distFn, candidates, undefined, options.clock)
      if (candidates.size > 0) {
        setSingleEntryPoint(workspace, candidates.ords[0])
      }
    }

    searchLayer(state, query, qMag, ef, 0, searchMetric, true, distFn, candidates, filter, options.clock)
  } finally {
    unlockGraphShared(state.locks)
  }
  return { candidates, depth: useQuantized ? depth : 0, arenaQuery, qMag, native: null }
}

interface ResolvedHit extends OrdinalHit {
  docId: string
}

function bestFirst(a: ResolvedHit, b: ResolvedHit): number {
  return b.score - a.score || compareCodePoints(a.docId, b.docId)
}

function resolveEvery(hits: OrdinalHit[], docIdOf: (ord: number) => string | undefined): ResolvedHit[] {
  const resolved: ResolvedHit[] = []
  for (const hit of hits) {
    const docId = docIdOf(hit.ord)
    if (docId !== undefined) resolved.push({ ord: hit.ord, score: hit.score, docId })
  }
  return resolved
}

function scoresDescend(hits: OrdinalHit[]): boolean {
  for (let i = 1; i < hits.length; i++) {
    if (!(hits[i].score <= hits[i - 1].score)) return false
  }
  return hits.length === 0 || !Number.isNaN(hits[0].score)
}

function bestResolvedHits(hits: OrdinalHit[], k: number, docIdOf: (ord: number) => string | undefined): ResolvedHit[] {
  if (!Number.isInteger(k) || k <= 0) {
    return resolveEvery(hits, docIdOf).sort(bestFirst).slice(0, k)
  }
  let ordered = hits
  if (!scoresDescend(ordered)) {
    if (hits.some(hit => Number.isNaN(hit.score))) return resolveEvery(hits, docIdOf).sort(bestFirst).slice(0, k)
    ordered = hits.slice().sort((a, b) => b.score - a.score)
  }
  const taken: ResolvedHit[] = []
  for (const hit of ordered) {
    if (taken.length >= k && hit.score < taken[k - 1].score) break
    const docId = docIdOf(hit.ord)
    if (docId !== undefined) taken.push({ ord: hit.ord, score: hit.score, docId })
  }
  return taken.sort(bestFirst).slice(0, k)
}

function collectHits(
  state: HNSWSearchState,
  query: Float32Array,
  k: number,
  searchMetric: VectorMetric,
  minSimilarity: number,
  options: GraphSearchOptions,
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

  const traversal = traverse(state, query, k, searchMetric, options)
  const { candidates } = traversal
  const filter = options.filter
  if (traversal.depth === 0) return estimatedHits(candidates, 0, searchMetric, minSimilarity, filter)

  const rescored = rescoredHits(state, traversal, query, traversal.depth, searchMetric, minSimilarity, filter)
  if (options.rescoreWindow === undefined || minSimilarity !== Number.NEGATIVE_INFINITY) return rescored
  const rest = endOfRescored(candidates, traversal.depth, filter)
  return rescored.concat(estimatedHits(candidates, rest, searchMetric, minSimilarity, filter))
}

function endOfRescored(candidates: DistanceList, depth: number, filter: OrdinalFilter | undefined): number {
  if (filter === undefined) return Math.min(depth, candidates.size)
  let taken = 0
  for (let i = 0; i < candidates.size; i++) {
    if (!ordinalFilterHas(filter, candidates.ords[i])) continue
    taken += 1
    if (taken === depth) return i + 1
  }
  return candidates.size
}

function estimatedHits(
  candidates: DistanceList,
  from: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
): OrdinalHit[] {
  const hits: OrdinalHit[] = []
  for (let i = from; i < candidates.size; i++) {
    const ord = candidates.ords[i]
    if (filter && !ordinalFilterHas(filter, ord)) continue
    const score = toScore(candidates.distances[i], metric)
    if (score < minSimilarity) continue
    hits.push({ ord, score })
  }
  return hits
}

function rescoredHits(
  state: HNSWSearchState,
  traversal: Traversal,
  query: Float32Array,
  depth: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
): OrdinalHit[] {
  const { candidates, native } = traversal
  if (native !== null) {
    const rescored = nativeRescoredHits(native.store, candidates, query, depth, metric, minSimilarity, filter)
    if (rescored !== null) return rescored
    const arena = state.store.prepareQueryArena(query)
    const qMag = arena ? arena.magnitude : magnitude(query)
    return rescoreWithFullPrecision(state, candidates, query, qMag, arena, depth, metric, minSimilarity, filter)
  }
  const { qMag, arenaQuery } = traversal
  return rescoreWithFullPrecision(state, candidates, query, qMag, arenaQuery, depth, metric, minSimilarity, filter)
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
): OrdinalHit[] {
  noteFallback('score')
  const rescored: OrdinalHit[] = []
  let taken = 0

  for (let i = 0; i < candidates.size && taken < depth; i++) {
    const ord = candidates.ords[i]
    if (filter && !ordinalFilterHas(filter, ord)) continue
    taken += 1

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
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, options)
  return bestResolvedHits(hits, k, docIdOf).map(hit => ({
    docId: hit.docId,
    score: hit.score,
    termFrequencies: {},
    fieldLengths: {},
    idf: {},
  }))
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
  const hits = collectHits(state, query, k, searchMetric, minSimilarity, options)
  return bestResolvedHits(hits, k, docIdOf)
}
