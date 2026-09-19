import type { VectorMetric } from '../brute-force'
import type { HNSWSearchState } from '../hnsw/shared'
import { type DistanceList, ensureListCapacity } from '../hnsw/workspace'
import { type NativeField, nativeMetricCode, reserveCandidates } from './field'

const NOTHING_TO_LINK = -1

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
  const count = field.core.search(
    field.handle,
    query,
    nativeMetricCode(metric),
    candidateCount,
    state.locks.threadSlot,
    field.ordinals,
    field.distances,
  )
  if (count < 0) return false
  copyCandidates(field, 0, count, candidates)
  return true
}

export function nativeRescore(
  field: NativeField,
  query: Float32Array,
  metric: VectorMetric,
  ordinals: Int32Array,
  count: number,
  distances: Float64Array,
): boolean {
  return field.core.rescore(field.handle, query, nativeMetricCode(metric), ordinals, count, distances) === 0
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
  const linkTop = field.core.place(
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
  if (linkTop < NOTHING_TO_LINK) return null
  for (let layer = 0; layer <= linkTop; layer++) {
    copyCandidates(field, layer * efConstruction, field.layerCounts[layer], perLayer[layer])
  }
  return linkTop
}
