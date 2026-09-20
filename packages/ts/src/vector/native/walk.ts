import type { VectorMetric } from '../brute-force'
import type { OrdinalHit } from '../hnsw/search'
import { type HNSWSearchState, toScore } from '../hnsw/shared'
import { type DistanceList, ensureListCapacity } from '../hnsw/workspace'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { stopUsingTheNativeSearchCore } from './backend'
import type { NativeField } from './field'
import { type NativeStore, nativeMetricCode, nativeScores, reserveOrdinals } from './store'

function copyCandidates(store: NativeStore, count: number, target: DistanceList): void {
  ensureListCapacity(target, count)
  target.ords.set(store.ordinals.subarray(0, count))
  target.distances.set(store.distances.subarray(0, count))
  target.size = count
}

export function nativeTraverse(
  state: HNSWSearchState,
  field: NativeField,
  query: Float32Array,
  candidateCount: number,
  metric: VectorMetric,
  candidates: DistanceList,
): boolean {
  const store = field.store
  reserveOrdinals(store, candidateCount)
  let count: number
  try {
    count = field.core.search(
      field.graph,
      store.handle,
      query,
      nativeMetricCode(metric),
      candidateCount,
      state.locks.threadSlot,
      store.ordinals,
      store.distances,
    )
  } catch (error) {
    stopUsingTheNativeSearchCore(error)
    return false
  }
  if (count < 0) return false
  copyCandidates(store, count, candidates)
  return true
}

export function nativeRescoredHits(
  store: NativeStore,
  candidates: DistanceList,
  query: Float32Array,
  depth: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
): OrdinalHit[] | null {
  const nearest = Math.min(candidates.size, depth)
  reserveOrdinals(store, nearest)
  const ordinals = store.ordinals
  let kept = 0
  for (let i = 0; i < nearest; i++) {
    const ord = candidates.ords[i]
    if (filter && !ordinalFilterHas(filter, ord)) continue
    ordinals[kept++] = ord
  }

  const distances = nativeScores(store, query, metric, kept)
  if (distances === null) return null

  const hits: OrdinalHit[] = []
  for (let i = 0; i < kept; i++) {
    if (distances[i] === Number.POSITIVE_INFINITY) continue
    const score = toScore(distances[i], metric)
    if (score < minSimilarity) continue
    hits.push({ ord: ordinals[i], score })
  }
  return hits
}
