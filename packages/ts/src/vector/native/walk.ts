import type { VectorMetric } from '../brute-force'
import type { OrdinalHit } from '../hnsw/search'
import { type HNSWSearchState, toScore } from '../hnsw/shared'
import { type DistanceList, ensureListCapacity } from '../hnsw/workspace'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { type NativeField, nativeMetricCode, reserveCandidates, stopUsingTheNativeSearchCore } from './field'

const NOTHING_LINKED = 0
const RESCORE_SUCCEEDED = 0

function copyCandidates(field: NativeField, offset: number, count: number, target: DistanceList): void {
  ensureListCapacity(target, count)
  target.ords.set(field.ordinals.subarray(offset, offset + count))
  target.distances.set(field.distances.subarray(offset, offset + count))
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
  reserveCandidates(field, candidateCount)
  let count: number
  try {
    count = field.core.search(
      field.handle,
      query,
      nativeMetricCode(metric),
      candidateCount,
      state.locks.threadSlot,
      field.ordinals,
      field.distances,
    )
  } catch (error) {
    stopUsingTheNativeSearchCore(error)
    return false
  }
  if (count < 0) return false
  copyCandidates(field, 0, count, candidates)
  return true
}

export function nativeRescoredHits(
  field: NativeField,
  candidates: DistanceList,
  query: Float32Array,
  depth: number,
  metric: VectorMetric,
  minSimilarity: number,
  filter: OrdinalFilter | undefined,
): OrdinalHit[] | null {
  if (!field.holdsEveryVector) return null
  const nearest = Math.min(candidates.size, depth)
  reserveCandidates(field, nearest)
  const ordinals = field.ordinals
  const distances = field.distances
  let kept = 0
  for (let i = 0; i < nearest; i++) {
    const ord = candidates.ords[i]
    if (filter && !ordinalFilterHas(filter, ord)) continue
    ordinals[kept++] = ord
  }

  let status: number
  try {
    status = field.core.rescore(field.handle, query, nativeMetricCode(metric), ordinals, kept, distances)
  } catch (error) {
    stopUsingTheNativeSearchCore(error)
    return null
  }
  if (status !== RESCORE_SUCCEEDED) return null

  const hits: OrdinalHit[] = []
  for (let i = 0; i < kept; i++) {
    if (distances[i] === Number.POSITIVE_INFINITY) continue
    const score = toScore(distances[i], metric)
    if (score < minSimilarity) continue
    hits.push({ ord: ordinals[i], score })
  }
  return hits
}

export function nativePlacementCandidates(
  state: HNSWSearchState,
  field: NativeField,
  vector: Float32Array,
  metric: VectorMetric,
  ownOrdinal: number,
  topLayer: number,
  efConstruction: number,
  perLayer: DistanceList[],
): number | null {
  const layers = topLayer + 1
  reserveCandidates(field, layers * efConstruction)
  if (field.layerCounts.length !== layers) field.layerCounts = new Int32Array(layers)
  const ordinals = field.ordinals.subarray(0, layers * efConstruction)
  const distances = field.distances.subarray(0, layers * efConstruction)
  let linked: number
  try {
    linked = field.core.place(
      field.handle,
      vector,
      nativeMetricCode(metric),
      ownOrdinal,
      topLayer,
      state.locks.threadSlot,
      ordinals,
      distances,
      field.layerCounts,
    )
  } catch (error) {
    stopUsingTheNativeSearchCore(error)
    return null
  }
  if (linked < NOTHING_LINKED) return null

  const linkTop = linked - 1
  for (let layer = 0; layer <= linkTop; layer++) {
    copyCandidates(field, layer * efConstruction, field.layerCounts[layer], perLayer[layer])
  }
  return linkTop
}
